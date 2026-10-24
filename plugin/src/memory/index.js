/**
 * dsh-goal-agenda/memory — 记忆库的写入与召回。
 *
 * 两个挂点，都注册在该 Agent 自己的 scope 里：
 *   1. `systemPrompt.context()`（order 250，排在 goal 之前）—— 把常驻档案 + 本轮
 *      相关记忆渲染进 runtime-context 快照。
 *   2. `tools.register()` —— `memory` 工具，增 / 改 / 归档 / 恢复 / 查。
 *
 * 只对 cwd 落在 `workspaceRoot` 下的会话注册。
 */

import { isAbsolute } from 'node:path'

import { GROWTH_KINDS, KINDS, MemoryStore, RESIDENT_KINDS, STATUSES, summarize } from './store.js'
import { renderMemoryBlock, retrieve, sameSubjectEntries, similarity } from './retrieval.js'
import { backfillEmbeddings, createEmbedder, embeddingFields, entrySimilarity } from './embedding.js'

/** Cordis 插件名。 */
export const name = 'sinecause-memory'

/** 依赖的服务。 */
export const inject = ['tools', 'systemPrompt']

/** `memory` 工具接受的 action。 */
export const ACTIONS = [
  'add', 'update', 'archive', 'restore', 'supersede', 'expire', 'delete', 'list', 'search', 'curate',
]

/** 记忆块在 runtime context 里的排序位：早于 goal 的 300，晚于内建的 210。 */
const CONTEXT_ORDER = 250

const DESCRIPTION = '她自己的长期记忆：写进来、按需查回去、攒够了就整理。'
  + 'add 记一条（kind：anchor 长期设定 / self 她自己的边界与判断 / skill 学到的框架与路子 / fact 事实 / episode 一段经历 / promise 许下的承诺）；'
  + 'update 改一条；archive 隐藏（保留但不再召回）；restore 恢复；'
  + 'supersede 同一件事有了更新的学习，旧的让位并记下被谁取代；expire 时效过了，降权但保留；delete 永久删除；'
  + 'list 看最近；search 按关键词找；curate 看待整理的清单，整理完用 reset=true 复位计数；'
  + '过时是一个判断、两个去处：遇到和库里相近的信息，看当前实际情况——'
  + '新旧之间没有连续性（换掉了、不再成立）用 supersede 让位；'
  + '有连续性（同一件事在时间上继续）用 expire 降权，仍留在库里供总体分析。'
  + '只有错误的判断、误导的信息才 delete。'
  + '常驻的 anchor 和 self 每次请求都会出现在上下文末尾，所以要短、要稳；'
  + '流水（skill/fact/episode）只在相关时被召回，可以写细。'
  + '写见闻会推高整理计数，到阈值时上下文末尾会提醒她整理。'

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ACTIONS, description: '要做的操作。' },
    kind: { type: 'string', enum: KINDS, description: 'add：条目类别。' },
    title: { type: 'string', description: 'add：一句话标题，会作为召回时的锚点。' },
    content: { type: 'string', description: 'add：正文。查到什么就写什么，别加工成结论。' },
    keywords: {
      type: 'array',
      items: { type: 'string' },
      description: 'add：以后可能用来找到它的词，2-5 个。',
    },
    tags: { type: 'array', items: { type: 'string' }, description: 'add：粗分类标签。' },
    important: { type: 'integer', description: 'add：重要性 0-1000，越大越容易被召回。' },
    id: { type: 'string', description: 'update/archive/restore/supersede/delete：记忆 id（形如 mem_xxx）。' },
    by: {
      type: 'string',
      description: 'supersede：取代它的那条记忆 id。给了就把这条写进对方的 supersedes 里，留下去向。',
    },
    fields: {
      type: 'object',
      additionalProperties: true,
      description: 'update：要改的字段对象，例如 {"content":"…","important":500}。',
    },
    query: { type: 'string', description: 'search：要找什么。省略 list 时返回最近的条目。' },
    limit: { type: 'integer', description: 'list/search：最多返回几条，默认 10。' },
    reset: {
      type: 'boolean',
      description: 'curate：true 表示整理完了，把整理计数归零并记下时间；省略则只列出待整理的条目。',
    },
  },
  required: ['action'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    result: { type: 'string', description: '人类可读的执行结果。' },
  },
  required: ['result'],
}

/** 校验配置；statePath 缺失就在加载时失败。 */
function resolveConfig(config) {
  const statePath = config?.statePath
  if (typeof statePath !== 'string' || !isAbsolute(statePath)) {
    throw new TypeError('sinecause-memory: statePath 必须是 memory.json 的绝对路径')
  }
  const workspaceRoot = config?.workspaceRoot
  if (workspaceRoot !== undefined && (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot))) {
    throw new TypeError('sinecause-memory: workspaceRoot 必须是绝对路径')
  }
  const maxChars = config?.maxChars ?? 2400
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new TypeError('sinecause-memory: maxChars 必须是正整数')
  }
  const topK = config?.topK ?? 8
  if (!Number.isSafeInteger(topK) || topK < 1) {
    throw new TypeError('sinecause-memory: topK 必须是正整数')
  }
  const curationEvery = config?.curationEvery ?? 12
  if (!Number.isSafeInteger(curationEvery) || curationEvery < 1) {
    throw new TypeError('sinecause-memory: curationEvery 必须是正整数')
  }
  const embeddingConfig = config?.embedding
  if (embeddingConfig !== undefined && (embeddingConfig === null || typeof embeddingConfig !== 'object')) {
    throw new TypeError('sinecause-memory: embedding 必须是对象')
  }
  // 默认开启：装了 @huggingface/transformers 就用向量判断新旧；
  // 关掉或模型加载失败时自动退回词法，不影响记忆本身。
  const embedding = embeddingConfig?.enabled === false ? null : (embeddingConfig ?? {})
  // 向量尺度的相似阈值。实测 bge-base-zh-v1.5：同能力 0.88、同一话题 0.80、无关 0.62，
  // 取 0.75 能把"同一件事的新旧"和"只是中文都说一样"分开。换模型要重新标定。
  const vectorThreshold = config?.vectorThreshold ?? 0.75
  if (typeof vectorThreshold !== 'number' || !(vectorThreshold > 0) || vectorThreshold > 1) {
    throw new TypeError('sinecause-memory: vectorThreshold 必须在 (0, 1] 之间')
  }
  return { statePath, workspaceRoot, maxChars, topK, curationEvery, embedding, vectorThreshold }
}

import { inWorkspace } from '../workspace-gate.js'

export { inWorkspace } from '../workspace-gate.js'

/** 会话当前的工作目录。 */
function sessionCwd(ctx, agent) {
  try {
    const live = ctx.get?.('workingDirectory')?.get?.(agent.session)
    if (typeof live === 'string' && live !== '') return live
  } catch {
    // 服务缺席时退回创建时的 header。
  }
  return agent.session?.header?.cwd
}

/**
 * 取本轮用来检索的文字：最近一条真实用户消息。
 * 上下文注入的消息都带 `source.form`，据此排除，免得拿自己的尾巴当查询。
 */
export function lastUserText(session) {
  try {
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(seq)
      if (event?.type !== 'user/message') continue
      if (event.data?.source?.form !== undefined) continue
      const block = (event.data?.content ?? []).find(item => item?.type === 'text')
      if (typeof block?.text === 'string' && block.text.trim() !== '') return block.text
    }
  } catch {
    // 会话读取失败时当作没有查询，只注入常驻档案。
  }
  return ''
}

/** 按关键词或时间列条目，渲染成一行一条。 */
function renderList(entries, limit) {
  if (entries.length === 0) return '（没有匹配的记忆）'
  return entries.slice(0, limit)
    .map(entry => `[${entry.id}] ${entry.kind} · ${entry.title}：${entry.summary}`)
    .join('\n')
}

/** 本地时间戳，与 agenda 和界面上的时间一致；不要用 toISOString（那是 UTC）。 */
function localStamp(unixSeconds) {
  const date = new Date(unixSeconds * 1000)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 本地日期（YYYY-MM-DD），用于 validTo。 */
function localDate(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 到了整理阈值就追加一段提醒。整理是动作，不是时钟：攒够几次"强化 + 丰富"
 * 才提醒一次，所以她只在真的有东西可整理时被打断。
 */
export function curationNotice(meta, threshold) {
  const grown = Number(meta?.growthSinceCuration ?? 0)
  if (grown < threshold) return ''
  const since = meta?.lastCurationAt
  const when = typeof since === 'number' ? localStamp(since) : '从未整理'
  return [
    '### 该整理了',
    `上次整理：${when}。之后积累了 ${grown} 条见闻（阈值 ${threshold}）。`,
    '用 memory 的 curate 看清单：同类并成一条、反复出现的升成 self 或 anchor、过时的 supersede、确认不该留的才 delete。',
  ].join('\n')
}

/** 把一条条目渲染成一行。 */
function renderLine(entry) {
  return `[${entry.id}] ${entry.kind} · ${entry.title}：${entry.summary}`
}

/** 在 Agent 自己的 scope 里注册记忆注入与 memory 工具。 */
function registerForAgent(agent, resolved) {
  const ctx = agent.ctx
  const store = () => new MemoryStore(resolved.statePath)

  const embedder = resolved.embedding === null ? null : createEmbedder(resolved.embedding)
  // 两边都有向量就按向量比，缺一边退回词法——新旧判断不能因为没算向量就断掉。
  const compare = (left, right) => entrySimilarity(left, right, similarity)
  // 两套尺度：词法无关文本接近 0，向量在"同领域不同事"上就有 0.8，阈值必须分开。
  const hasVector = entry => Array.isArray(entry?.embedding) && entry.embedding.length > 0
  const thresholdFor = (left, right) =>
    (hasVector(left) && hasVector(right) ? resolved.vectorThreshold : 0.3)
  /** 算向量；模型没装好不该挡住写记忆，失败就当没有。 */
  const fillEmbedding = async draft => {
    if (embedder === null) return {}
    try {
      return await embeddingFields(draft, embedder)
    } catch {
      return {}
    }
  }

  const contextText = () => {
    try {
      const book = store()
      const query = lastUserText(agent.session)
      const block = renderMemoryBlock(
        retrieve(book.all(), query, { topK: resolved.topK }),
        { maxChars: resolved.maxChars },
      )
      const notice = curationNotice(book.meta(), resolved.curationEvery)
      return [block, notice].filter(part => part !== '').join('\n\n')
    } catch {
      // 记忆库坏了不该让请求失败：这一轮不注入。
      return ''
    }
  }

  ctx.systemPrompt.context({
    name: 'sinecause:memory',
    order: CONTEXT_ORDER,
    // 记忆正文是她自己写的用户数据，不能当提示词模板插值。
    interpolate: false,
    text: (context) => {
      const owner = context?.agent ?? agent
      if (!inWorkspace(sessionCwd(ctx, owner), resolved.workspaceRoot)) return ''
      return contextText()
    },
  })

  ctx.tools.register({
    name: 'memory',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    async execute(args, exec) {
      const cwd = sessionCwd(ctx, exec?.agent ?? agent)
      if (!inWorkspace(cwd, resolved.workspaceRoot)) {
        throw new Error(`memory 只在这个工作区的会话里可用（当前目录 ${String(cwd ?? '未知')}）`)
      }
      const book = store()
      const limit = Math.max(1, Number(args.limit ?? 10))
      switch (args.action) {
        case 'add': {
          const content = String(args.content ?? '').trim()
          if (content === '') throw new Error('add 需要 content')
          const kind = KINDS.includes(args.kind) ? args.kind : 'fact'
          // 先取现有的，才能算出"这条和库里哪些像"——同一能力的新旧判断靠相似度，不看时间。
          const before = book.all().filter(entry => entry.status === 'active' && !entry.deleted)
          const draft = {
            kind,
            title: args.title ?? localDate().slice(5),
            content,
            summary: summarize(content),
            keywords: Array.isArray(args.keywords) ? args.keywords : [],
            tags: Array.isArray(args.tags) ? args.tags : [],
            ...args.important === undefined ? {} : { important: Number(args.important) },
            source: 'agent',
          }
          const row = book.add({ ...draft, ...await fillEmbedding(draft) })
          // 只有攒见闻才推高整理计数；写档案（self/anchor）本身就是整理的结果。
          const grown = GROWTH_KINDS.includes(kind)
            ? book.setMeta({ growthSinceCuration: book.meta().growthSinceCuration + 1 }).growthSinceCuration
            : book.meta().growthSinceCuration
          const due = grown >= resolved.curationEvery ? `（积累 ${grown} 条，该整理了）` : ''
          // 常驻条目（self/anchor）本来就彼此像，不该互相提示"该让位"；
          // 其余按同类 + 共用关键词 + 分数 三道判据挑真正的"同一件事"。
          const near = RESIDENT_KINDS.includes(kind)
            ? []
            : sameSubjectEntries(before, row, {
              limit: 3,
              similarity: compare,
              threshold: thresholdFor,
            })
          const hint = near.length === 0
            ? ''
            : `\n库里相近：${near.map(hit => `[${hit.entry.id}] ${hit.entry.title}（${hit.score}）`).join('、')}`
              + '\n如果这是同一件事的新情况，用 supersede 把旧的让位。'
          return { result: `已记住 [${row.id}] ${row.kind} · ${row.title}${due}${hint}` }
        }
        case 'update': {
          const fields = args.fields
          if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
            throw new Error('update 需要 fields（要改的字段对象）')
          }
          const row = book.update(String(args.id ?? ''), fields)
          if (row === null) throw new Error(`找不到记忆：${String(args.id ?? '')}`)
          return { result: `已更新 [${row.id}] ${row.title}` }
        }
        case 'archive': {
          const row = book.archive(String(args.id ?? ''))
          if (row === null) throw new Error(`找不到记忆：${String(args.id ?? '')}`)
          return { result: `已归档 [${row.id}] ${row.title}（不再召回，可 restore）` }
        }
        case 'expire': {
          const id = String(args.id ?? '')
          const row = book.get(id)
          if (row === null) throw new Error(`找不到记忆：${id}`)
          const lowered = Math.floor(Math.max(0, Number(row.important ?? 0)) * 0.3)
          book.update(id, {
            validTo: row.validTo ?? localDate(),
            important: lowered,
          })
          return {
            result: `[${id}] ${row.title} 已按时效降权（重要度 ${row.important ?? 0} → ${lowered}；`
              + '不再抢先影响当下判断，仍留在库里供总体分析，可 restore 前用 update 改回重要度）',
          }
        }
        case 'restore': {
          const row = book.restore(String(args.id ?? ''))
          if (row === null) throw new Error(`找不到记忆：${String(args.id ?? '')}`)
          return { result: `已恢复 [${row.id}] ${row.title}` }
        }
        case 'supersede': {
          const id = String(args.id ?? '')
          const old = book.get(id)
          if (old === null) throw new Error(`找不到记忆：${id}`)
          const by = typeof args.by === 'string' && args.by !== '' ? args.by : null
          if (by !== null && book.get(by) === null) throw new Error(`找不到取代它的记忆：${by}`)
          book.update(id, {
            status: 'superseded',
            validTo: localDate(),
          })
          if (by !== null) {
            const successor = book.get(by)
            book.update(by, { supersedes: [...new Set([...(successor.supersedes ?? []), id])] })
          }
          return {
            result: `已把 [${id}] ${old.title} 标记为过时${by === null ? '' : `，由 [${by}] 取代`}`
              + '（不再召回，restore 可找回）',
          }
        }
        case 'delete': {
          const id = String(args.id ?? '')
          if (!book.remove(id)) throw new Error(`找不到记忆：${id}`)
          return { result: `已永久删除 ${id}（不可恢复）` }
        }
        case 'search': {
          const query = String(args.query ?? '').trim()
          const active = book.all().filter(entry => entry.status === 'active' && !entry.deleted)
          if (query === '') {
            const recent = [...active].sort((a, b) => Number(b.position ?? 0) - Number(a.position ?? 0))
            return { result: renderList(recent, limit) }
          }
          const hits = retrieve(active, query, { topK: limit }).matches
          return { result: renderList(hits, limit) }
        }
        case 'list': {
          const active = book.all().filter(entry => entry.status === 'active' && !entry.deleted)
          const recent = [...active].sort((a, b) => Number(b.position ?? 0) - Number(a.position ?? 0))
          return { result: renderList(recent, limit) }
        }
        case 'curate': {
          const meta = book.meta()
          if (args.reset === true) {
            const stamped = book.setMeta({
              growthSinceCuration: 0,
              lastCurationAt: Math.trunc(Date.now() / 1000),
            })
            const when = localStamp(stamped.lastCurationAt)
            return { result: `已复位：上次整理记为 ${when}，计数归零（原 ${meta.growthSinceCuration} 条）。` }
          }
          const since = typeof meta.lastCurationAt === 'number' ? meta.lastCurationAt : 0
          const pending = book.all()
            .filter(entry => entry.status === 'active' && !entry.deleted
              && GROWTH_KINDS.includes(entry.kind)
              && Number(entry.updatedAt ?? 0) > since)
            .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
          if (pending.length === 0) {
            return { result: `没有待整理的条目（计数 ${meta.growthSinceCuration}）。` }
          }
          const lines = [
            `待整理 ${pending.length} 条（计数 ${meta.growthSinceCuration}，阈值 ${resolved.curationEvery}）：`,
          ]
          if (embedder !== null) {
            // 库里早先写的条目没有向量，整理时一次补齐，比逐条补划算。
            try {
              await backfillEmbeddings(book, embedder, { limit: 32 })
            } catch {
              // 模型不可用时按词法比，不阻塞整理。
            }
          }
          const active = book.all().filter(entry => entry.status === 'active' && !entry.deleted)
          for (const entry of pending.slice(0, 20)) {
            lines.push(renderLine(entry))
            // 只列真正可能是同一件事的：同类 + 共用关键词 + 分数过线。
            for (const hit of sameSubjectEntries(active, entry, {
              limit: 3,
              similarity: compare,
              threshold: thresholdFor,
            })) {
              lines.push(`    ~ 相近：[${hit.entry.id}] ${hit.entry.title}（${hit.score}）`)
            }
          }
          if (pending.length > 20) lines.push(`（另有 ${pending.length - 20} 条未列出）`)
          lines.push('对每条对照它的相近条目，判断这一件事的新旧：')
          lines.push('  · 没有连续性——换掉了、不再成立 → supersede，旧的让位并记下被谁取代')
          lines.push('  · 有连续性——同一件事在时间上继续（状态、行情、当次判断）→ expire 降权，旧的留着供总体分析')
          lines.push('  · 重复的合并后 archive；错误或误导的才 delete')
          lines.push('判断靠相似度 + 当前实际情况；相似度由工具给出，实际情况只有她知道。')
          lines.push('收完调用 memory curate reset=true 复位。')
          return { result: lines.join('\n') }
        }
        default:
          throw new Error(`action 只支持 ${ACTIONS.join(' / ')}`)
      }
    },
  })
}

/** 暴露给测试的状态常量。 */
export { KINDS, STATUSES }

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  ctx.on('agent/created', ({ agent }) => {
    if (!inWorkspace(sessionCwd(ctx, agent), resolved.workspaceRoot)) return
    try {
      registerForAgent(agent, resolved)
    } catch (error) {
      // 注册失败只该让这个会话少一个工具，不该让会话建不起来。
      ctx.logger?.warn?.(`sinecause-memory: 注册失败：${String(error?.message ?? error)}`)
    }
  })
}
