/**
 * 记忆检索：先做词法 + 时效 + 重要性的确定性打分，接口留好向量位。
 *
 * 移植自 ConsciousnessRealm/memory/memory_retrieval.py，区别是暂时没有向量项
 * （参考实现里 `6.0 * 向量` 那一项），词法权重相应放大两倍保持相对量级。
 * 换成向量时只需在 scoreOf 里补一项，调用方不用改。
 */

import { RESIDENT_KINDS } from './store.js'

/** 相关记忆的默认条数。 */
const DEFAULT_TOP_K = 8

/** 注入块的字数上限；常驻条目先占，剩下的才给相关条目。 */
const DEFAULT_MAX_CHARS = 2400

/** 低于这个分数不进上下文。没有向量时，一个关键词命中（4 分）刚好过线。 */
const DEFAULT_MIN_SCORE = 2

/**
 * 时效已过的条目按这个系数降权：减半，不排除。
 * 它不该抢占当下判断，但"以前发生过什么"仍是总体分析的材料——
 * 压得太狠（比如 0.3）会直接掉到召回线以下，等于变相隐藏。
 */
export const EXPIRED_FACTOR = 0.5

/** 拼出用于相似度比较的文字。 */
function comparableText(entry) {
  return [entry.title, entry.summary, ...(entry.keywords ?? [])].filter(Boolean).join(' ')
}

/** 去标点后取相邻双字，中文不用分词也能比。 */
function bigrams(text) {
  const clean = String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  const set = new Set()
  for (let index = 0; index + 1 < clean.length; index += 1) set.add(clean.slice(index, index + 2))
  return set
}

/**
 * 两条记忆的相似度：双字重合数 / 较短一条的双字数。
 * 用重合系数而不是 Jaccard——短条目被长条目的细节稀释时，仍然该被认出来。
 *
 * 这是**唯一需要换成向量的地方**。词法相似度认不出"同一个能力换了说法"
 * （无头浏览器 / playwright），迟早会误判；换的时候只要提供另一个
 * `(left, right) => number` 传进 {@link similarEntries} 的 `similarity` 选项，
 * 调用方不用改。v2 schema 里已经留了 `embedding` / `embeddingModel` /
 * `embeddingVersion` / `embeddingHash` 四个字段，normalize 会原样保留。
 * @param {object} left
 * @param {object} right
 * @returns {number} 0 到 1。
 */
export function similarity(left, right) {
  const a = bigrams(comparableText(left))
  const b = bigrams(comparableText(right))
  if (a.size === 0 || b.size === 0) return 0
  let hit = 0
  for (const gram of a) if (b.has(gram)) hit += 1
  return hit / Math.min(a.size, b.size)
}

/**
 * 找出库里和这一条最像的条目。
 *
 * 「同一件事又有了新情况」的判断入口：相似度是一半，另一半是当前实际情况，
 * 那部分只能由她判断。结果怎么处置是 caller 的事——
 * 新旧之间没有连续性就替换（supersede），有连续性就降权（expire）。
 * @param {object[]} entries - 候选条目（调用方先筛掉非 active 的）。
 * @param {object} target - 正在整理或刚写进来的那一条。
 * @param {{ limit?: number, threshold?: number | ((left: object, right: object) => number), excludeId?: string, similarity?: (left: object, right: object) => number }} [options]
 *   `threshold` 可以是数字，也可以是按这一对条目取阈值的函数——向量和词法的分数尺度不同，
 *   bge 中文余弦在无关文本上也有 0.6，用词法的 0.3 会把所有人都判成相似。
 * @returns {{ entry: object, score: number }[]} 按相似度降序。
 */
export function similarEntries(entries, target, options = {}) {
  const limit = options.limit ?? 3
  const declared = options.threshold ?? 0.3
  const thresholdFor = typeof declared === 'function' ? declared : () => declared
  const compare = options.similarity ?? similarity
  const scored = []
  for (const entry of entries) {
    if (entry.deleted || entry.status !== 'active') continue
    if (options.excludeId !== undefined && entry.id === options.excludeId) continue
    if (target?.id !== undefined && entry.id === target.id) continue
    const score = compare(entry, target)
    if (score < thresholdFor(entry, target)) continue
    scored.push({ entry, score: Math.round(score * 100) / 100 })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/** 时效已过：validTo 落在今天之前。 */
function expired(entry, now) {
  const validTo = entry.validTo
  if (typeof validTo !== 'string' || validTo === '') return false
  const until = Date.parse(`${validTo}T23:59:59`)
  return Number.isFinite(until) && until < now
}

/** 词法命中：关键词、标签、实体出现在查询里。 */
function lexicalScore(entry, query) {
  let score = 0
  for (const keyword of entry.keywords ?? []) {
    if (String(keyword) && query.includes(String(keyword))) score += 2
  }
  for (const tag of entry.tags ?? []) {
    if (String(tag) && query.includes(String(tag))) score += 1
  }
  for (const items of Object.values(entry.entities ?? {})) {
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if (String(item) && query.includes(String(item))) score += 1.5
    }
  }
  if (query && String(entry.content ?? '').includes(query)) score += 1
  return score
}

/** 时效：90 天内线性衰减到 0。 */
function recencyScore(entry, now) {
  const timestamp = Number(entry.timestamp ?? 0)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0
  const ageDays = Math.max(0, (now / 1000 - timestamp) / 86400)
  return Math.max(0, 1 - ageDays / 90)
}

/** 一条记忆的总分。向量实现之后在这里加 `6.0 * similarity`。 */
export function scoreOf(entry, query, now = Date.now()) {
  const base = 2 * lexicalScore(entry, query)
    + recencyScore(entry, now)
    + Math.max(0, Number(entry.important ?? 0)) / 1000
    + (entry.kind === 'promise' ? 1.5 : 0)
  // 时效过期的条目降权而不是排除：它对"此刻该怎么做"参考价值低了，
  // 但拿来做总体分析仍然有效，所以还留在库里、仍可被召回。
  return expired(entry, now) ? base * EXPIRED_FACTOR : base
}

/**
 * 检索：常驻条目全给，其余按分排序取前 K。
 * @param {object[]} entries - 记忆库全部条目。
 * @param {string} query - 本轮用来找相关记忆的文字。
 * @param {{ topK?: number, minScore?: number, now?: number }} [options]
 * @returns {{ anchors: object[], matches: object[] }}
 */
export function retrieve(entries, query, options = {}) {
  const topK = options.topK ?? DEFAULT_TOP_K
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE
  const now = options.now ?? Date.now()
  const anchors = []
  const matches = []
  const text = String(query ?? '').trim()
  for (const entry of entries) {
    if (entry.deleted || entry.status !== 'active') continue
    if (entry.constant) {
      anchors.push(entry)
      continue
    }
    if (RESIDENT_KINDS.includes(entry.kind)) continue
    if (text === '') continue
    const score = scoreOf(entry, text, now)
    if (score < minScore) continue
    matches.push({ ...entry, score: Math.round(score * 1000) / 1000 })
  }
  matches.sort((a, b) => b.score - a.score || Number(b.position ?? 0) - Number(a.position ?? 0))
  anchors.sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
  return { anchors, matches: matches.slice(0, topK) }
}

/**
 * 两条记忆是否共用关键词或标签（大小写不敏感）。
 * @param {object} left
 * @param {object} right
 * @returns {boolean}
 */
export function shareTerms(left, right) {
  const terms = new Set(
    [...(left.keywords ?? []), ...(left.tags ?? [])]
      .map(term => String(term).toLowerCase())
      .filter(Boolean),
  )
  if (terms.size === 0) return false
  return [...(right.keywords ?? []), ...(right.tags ?? [])]
    .some(term => terms.has(String(term).toLowerCase()))
}

/** 高于这个分数，就算换了说法也认作同一条。 */
export const NEAR_DUPLICATE = 0.93

/**
 * 「这是不是同一件事的新情况」——光看余弦不够。
 *
 * 她的记忆全长在同一个语境里，同领域但不同事的余弦本来就有 0.82–0.89
 * （实测五条：每条新记忆都能和另外三条"相近"）。单靠阈值会让每次写入都弹
 * 三条无关的"库里相近"，反而诱导错误的 supersede。
 *
 * 所以要求：**同类**，且（共用关键词/标签 且 分数过线），或者几乎就是同一条。
 * @param {object} left
 * @param {object} right
 * @param {number} score - 两者的相似度。
 * @param {{ threshold?: number | ((left: object, right: object) => number) }} [options]
 *   共用关键词时的分数下限。给函数是因为两套尺度不同：词法的无关文本接近 0，
 *   向量在"同领域不同事"上就有 0.8，用同一个数必然一端失效。
 * @returns {boolean}
 */
export function likelySameSubject(left, right, score, options = {}) {
  if (left.kind !== right.kind) return false
  if (score >= NEAR_DUPLICATE) return true
  const declared = options.threshold ?? 0.75
  const floor = typeof declared === 'function' ? declared(left, right) : declared
  return shareTerms(left, right) && score >= floor
}

/**
 * 找出「可能是同一件事」的条目，按相似度降序。
 * @param {object[]} entries - 候选（调用方先筛掉非 active 的）。
 * @param {object} target
 * @param {{ limit?: number, similarity?: (left: object, right: object) => number, threshold?: number | ((left: object, right: object) => number) }} [options]
 * @returns {{ entry: object, score: number }[]}
 */
export function sameSubjectEntries(entries, target, options = {}) {
  const scored = similarEntries(entries, target, {
    // 先取全部候选再过滤：`similarEntries` 会先按分数截断，若在这里限 12 条，
    // 库里条目一多，真正同类的那条只要原始分数排在 12 名之后就会被丢掉。
    limit: entries.length,
    similarity: options.similarity,
    threshold: () => 0,
  })
  return scored
    .filter(hit => likelySameSubject(hit.entry, target, hit.score, options))
    .slice(0, options.limit ?? 3)
}

/**
 * 渲染成注入块。常驻条目先写，相关条目按预算裁掉尾部。
 * @param {{ anchors: object[], matches: object[] }} result
 * @param {{ maxChars?: number }} [options]
 * @returns {string} 没有任何条目时返回空串。
 */
export function renderMemoryBlock(result, options = {}) {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const anchors = result.anchors ?? []
  const matches = result.matches ?? []
  if (anchors.length === 0 && matches.length === 0) return ''

  const head = '## 记忆'
  const body = []
  let used = head.length
  const section = (title, rows, format) => {
    const lines = []
    let cost = title.length + 1
    for (const entry of rows) {
      const line = format(entry)
      const next = line.length + 1
      if (used + cost + next > maxChars) break
      cost += next
      lines.push(line)
    }
    // 标题跟着条目走：一条都放不下就整段省略，不留空标题。
    if (lines.length === 0) return
    used += cost
    body.push(title, ...lines)
  }

  section('### 长期有效', anchors, entry => `- ${entry.title}：${entry.summary}`)
  // 带上 id，她才能对这条记忆做 update / archive。
  section('### 相关', matches, entry => `- [${entry.id}] ${entry.title}：${entry.summary}`)
  if (body.length === 0) return ''
  return [head, ...body].join('\n')
}
