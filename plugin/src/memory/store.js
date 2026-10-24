/**
 * 记忆库：v2 schema 与 JSON 存储，移植自 SineCause 的
 * ConsciousnessRealm/memory/memory_store.py。
 *
 * 与参考实现保持字段兼容，因此两边的文件可以互读：
 *   { schema_version: 2, entries: [...] }
 *
 * 相对参考实现加了两类 kind：
 *   self  —— 她自己的边界、判断、在意的事（常驻档案）
 *   skill —— 学到的框架、工具、走通过的路子
 * 原有的 anchor 仍表示"长期有效的整体设定"，self/skill 是可单独增删的条目。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 当前 schema 版本。 */
export const SCHEMA_VERSION = 2

/** 条目状态。superseded 表示被更新的条目取代，但不删除。 */
export const STATUSES = ['active', 'superseded', 'archived', 'deleted']

/** 条目类别。anchor/self 会常驻上下文，其余按需检索。 */
export const KINDS = ['anchor', 'self', 'skill', 'fact', 'episode', 'promise']

/** 常驻类别：这两类每次请求都会进上下文，所以要短。 */
export const RESIDENT_KINDS = ['anchor', 'self']

function text(value) {
  return String(value ?? '').trim()
}

/** 稳定 id：同一条内容重复写入会得到同一个 id。 */
function stableId(entry, used) {
  const basis = [text(entry.title), text(entry.content), String(entry.timestamp ?? '')].join('\x1f')
  const base = `mem_${createHash('sha1').update(basis, 'utf8').digest('hex').slice(0, 16)}`
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`
    suffix += 1
  }
  used.add(candidate)
  return candidate
}

/** 摘要：在标点处切断，切不出来才硬截。 */
export function summarize(content, limit = 120) {
  const flat = text(content).replace(/\s+/g, ' ')
  if (flat.length <= limit) return flat
  const cut = Math.max(
    flat.lastIndexOf('。', limit),
    flat.lastIndexOf('；', limit),
    flat.lastIndexOf('，', limit),
  )
  return cut >= 40 ? flat.slice(0, cut + 1) : `${flat.slice(0, limit).trimEnd()}…`
}

/** 补齐 v2 字段；未知字段原样保留，避免迁移时丢数据。 */
export function normalize(entry, used = new Set()) {
  const row = { ...(entry ?? {}) }
  let timestamp = Number(row.timestamp ?? Date.now() / 1000)
  if (!Number.isFinite(timestamp)) timestamp = Date.now() / 1000
  let id = text(row.id)
  if (id === '' || used.has(id)) id = stableId(row, used)
  row.id = id
  used.add(id)
  row.kind = KINDS.includes(row.kind) ? row.kind : 'fact'
  row.status = STATUSES.includes(row.status) ? row.status : 'active'
  row.keywords = Array.isArray(row.keywords) ? row.keywords : []
  row.entities = row.entities !== null && typeof row.entities === 'object' ? row.entities : {}
  row.tags = Array.isArray(row.tags) ? row.tags : []
  row.summary = text(row.summary) === '' ? summarize(row.content) : row.summary
  row.source = row.source ?? 'agent'
  row.confidence = typeof row.confidence === 'number' ? row.confidence : 1
  row.validFrom = row.validFrom ?? new Date(timestamp * 1000).toISOString().slice(0, 10)
  row.validTo = row.validTo ?? null
  row.supersedes = Array.isArray(row.supersedes) ? row.supersedes : []
  row.deleted = Boolean(row.deleted)
  row.updatedAt = Number.isFinite(Number(row.updatedAt)) ? Number(row.updatedAt) : Math.trunc(timestamp)
  row.timestamp = timestamp
  // 常驻条目必须带 constant，检索侧才认。
  if (RESIDENT_KINDS.includes(row.kind)) {
    row.constant = true
    row.important = Number(row.important) || 1000
  } else {
    row.constant = Boolean(row.constant)
  }
  return row
}

/** 计为"强化 + 丰富"的类别：这些是她攒进来的新见闻，会推高整理计数。 */
export const GROWTH_KINDS = ['skill', 'episode', 'fact']

/** 文档里除 entries 之外的头部字段默认值。 */
export const DEFAULT_META = { growthSinceCuration: 0, lastCurationAt: null }

/** 记忆库实例：构造时读盘，写操作立即落盘。 */
export class MemoryStore {
  /** @param {string} path - memory.json 的绝对路径。 */
  constructor(path) {
    this.path = path
    this.cache = null
    this.metaCache = null
    this.stamp = null
  }

  /** 读盘；文件没变就复用缓存（按 mtime + size 判断）。 */
  load() {
    let stamp = null
    try {
      const info = statSync(this.path)
      stamp = `${info.mtimeMs}:${info.size}`
    } catch {
      stamp = null
    }
    if (this.cache === null || stamp === null || stamp !== this.stamp) {
      try {
        const raw = JSON.parse(readFileSync(this.path, 'utf8'))
        this.cache = Array.isArray(raw) ? raw : (raw?.entries ?? [])
        this.metaCache = Array.isArray(raw) || raw === null || typeof raw !== 'object'
          ? { ...DEFAULT_META }
          : { ...DEFAULT_META, ...(raw.meta ?? {}) }
      } catch {
        this.cache = []
        this.metaCache = { ...DEFAULT_META }
      }
      this.stamp = stamp
    }
    const used = new Set()
    return this.cache
      .filter(entry => entry !== null && typeof entry === 'object')
      .map(entry => normalize(entry, used))
  }

  /** 头部元数据：整理计数与上次整理时间。 */
  meta() {
    this.load()
    return { ...DEFAULT_META, ...(this.metaCache ?? {}) }
  }

  /** 改头部元数据并落盘。 */
  setMeta(patch) {
    const entries = this.load()
    this.save(entries, { ...this.meta(), ...(patch ?? {}) })
    return this.meta()
  }

  /** 原子写盘，保留文件里除 entries/meta 之外的头部字段。 */
  save(entries, meta = this.metaCache ?? DEFAULT_META) {
    mkdirSync(dirname(this.path), { recursive: true })
    let head = {}
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        head = Object.fromEntries(
          Object.entries(raw).filter(([key]) => key !== 'entries' && key !== 'meta'),
        )
      }
    } catch {
      head = {}
    }
    const payload = {
      ...head,
      schema_version: SCHEMA_VERSION,
      meta: { ...DEFAULT_META, ...meta },
      entries: [...entries].sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0)),
    }
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.path)
    this.cache = payload.entries
    this.metaCache = payload.meta
    try {
      const info = statSync(this.path)
      this.stamp = `${info.mtimeMs}:${info.size}`
    } catch {
      this.stamp = null
    }
  }

  /** 全部条目。 */
  all() {
    return this.load()
  }

  /** 按 id 取一条。 */
  get(id) {
    return this.load().find(entry => entry.id === id) ?? null
  }

  /** 新增一条，返回落盘后的记录。 */
  add(record) {
    const entries = this.load()
    const row = normalize(record, new Set(entries.map(entry => entry.id)))
    row.position = Number(record?.position) || Math.max(0, ...entries.map(entry => Number(entry.position ?? 0))) + 1
    entries.push(row)
    this.save(entries)
    return row
  }

  /** 改一条；返回 null 表示 id 不存在。 */
  update(id, fields) {
    const entries = this.load()
    const index = entries.findIndex(entry => entry.id === id)
    if (index < 0) return null
    const patch = { ...(fields ?? {}) }
    // 正文变了却没给新摘要时必须重算：召回块渲染的是 title：summary，
    // 留着旧摘要就会显示旧内容；而且 embeddingHash 由 title+summary+keywords
    // 组成，摘要不动它就一直匹配，旧向量永远不会被判定为过期。
    if (typeof patch.content === 'string' && patch.summary === undefined) {
      patch.summary = summarize(patch.content)
    }
    const merged = { ...entries[index], ...patch, id }
    merged.updatedAt = Math.trunc(Date.now() / 1000)
    const others = new Set(entries.filter((_, position) => position !== index).map(entry => entry.id))
    entries[index] = normalize(merged, others)
    this.save(entries)
    return entries[index]
  }

  /** 归档：保留但不参与检索。 */
  archive(id) {
    return this.update(id, { status: 'archived', deleted: true })
  }

  /** 恢复归档条目。 */
  restore(id) {
    return this.update(id, { status: 'active', deleted: false })
  }

  /** 永久删除，不可恢复。 */
  remove(id) {
    const entries = this.load()
    const kept = entries.filter(entry => entry.id !== id)
    if (kept.length === entries.length) return false
    this.save(kept)
    return true
  }
}
