import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { MemoryStore, SCHEMA_VERSION, normalize, summarize } from '../src/memory/store.js'
import {
  cosine,
  embeddingFresh,
  embeddingHash,
  embeddingText,
  entrySimilarity,
} from '../src/memory/vector.js'
import {
  likelySameSubject,
  renderMemoryBlock,
  retrieve,
  sameSubjectEntries,
  scoreOf,
  shareTerms,
  similarEntries,
  similarity,
} from '../src/memory/retrieval.js'

let root
let path

before(() => {
  root = mkdtempSync(join(tmpdir(), 'sinecause-memory-'))
  path = join(root, 'state', 'memory.json')
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('memory store', () => {
  it('starts empty when the file is missing', () => {
    const store = new MemoryStore(path)
    assert.deepEqual(store.all(), [])
  })

  it('normalizes missing v2 fields', () => {
    const row = normalize({ title: '生日', content: '他 3 月 12 日生日' })
    assert.match(row.id, /^mem_[0-9a-f]{16}$/)
    assert.equal(row.kind, 'fact')
    assert.equal(row.status, 'active')
    assert.equal(row.confidence, 1)
    assert.deepEqual(row.keywords, [])
    assert.equal(row.constant, false)
    assert.equal(row.deleted, false)
  })

  it('keeps resident kinds constant and important', () => {
    const row = normalize({ kind: 'self', title: '我立的界', content: '绕开里亚姐的事，不做' })
    assert.equal(row.constant, true)
    assert.equal(row.important, 1000)
  })

  it('gives identical content the same id and de-duplicates collisions', () => {
    const used = new Set()
    const first = normalize({ title: 'a', content: 'b', timestamp: 1 }, used)
    const second = normalize({ title: 'a', content: 'b', timestamp: 1 }, used)
    assert.notEqual(first.id, second.id)
    assert.equal(second.id, `${first.id}_2`)
  })

  it('persists atomically with a schema version and reloads', () => {
    const store = new MemoryStore(path)
    const row = store.add({ kind: 'skill', title: 'DSH runtime-context', content: '尾部快照内容不变就不重发' })
    assert.equal(row.position, 1)
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(raw.schema_version, SCHEMA_VERSION)
    assert.equal(raw.entries.length, 1)
    const reread = new MemoryStore(path)
    assert.equal(reread.all()[0].title, 'DSH runtime-context')
  })

  it('updates, archives, restores and removes', () => {
    const store = new MemoryStore(path)
    const row = store.add({ title: 'QQ 通路', content: '只有紧接那一轮会自动回传' })
    const updated = store.update(row.id, { content: '只有紧接那一轮自动回传，其余要自己发', important: 300 })
    assert.equal(updated.important, 300)
    assert.equal(store.get(row.id).content, '只有紧接那一轮自动回传，其余要自己发')
    assert.equal(store.archive(row.id).status, 'archived')
    assert.equal(store.restore(row.id).status, 'active')
    assert.equal(store.remove(row.id), true)
    assert.equal(store.get(row.id), null)
    assert.equal(store.remove(row.id), false)
  })

  it('recomputes the summary when only the content changes', () => {
    const store = new MemoryStore(join(root, 'summary', 'memory.json'))
    const row = store.add({ kind: 'fact', title: '模型', content: '他用 v1', keywords: ['模型'] })
    const updated = store.update(row.id, { content: '他换到 v2 了，之前那条已经不对' })
    assert.equal(updated.summary, '他换到 v2 了，之前那条已经不对')
    // 摘要变了 → 指纹跟着变 → 旧向量会被判定过期并重算。
    assert.notEqual(updated.embeddingHash, embeddingHash(row))
  })

  it('keeps an explicitly supplied summary', () => {
    const store = new MemoryStore(join(root, 'summary2', 'memory.json'))
    const row = store.add({ kind: 'fact', title: 't', content: '长内容' })
    const updated = store.update(row.id, { content: '新内容', summary: '我自己写的摘要' })
    assert.equal(updated.summary, '我自己写的摘要')
  })

  it('summarizes at punctuation and falls back to a hard cut', () => {
    assert.equal(summarize('短句。'), '短句。')
    const long = `${'甲'.repeat(50)}。${'乙'.repeat(200)}`
    assert.ok(summarize(long).endsWith('。'))
    assert.ok(summarize('丙'.repeat(300), 20).endsWith('…'))
  })

  it('ignores a corrupt file instead of throwing', () => {
    const broken = join(root, 'broken.json')
    const store = new MemoryStore(broken)
    store.save([])
    assert.deepEqual(store.all(), [])
  })
})

describe('curation meta', () => {
  it('defaults to zero growth and no last curation', () => {
    const store = new MemoryStore(join(root, 'fresh', 'memory.json'))
    assert.deepEqual(store.meta(), { growthSinceCuration: 0, lastCurationAt: null })
  })

  it('round-trips meta through the document head', () => {
    const metaPath = join(root, 'meta', 'memory.json')
    const store = new MemoryStore(metaPath)
    store.add({ title: 'x', content: 'y' })
    store.setMeta({ growthSinceCuration: 3, lastCurationAt: 1_700_000_000 })
    const reread = new MemoryStore(metaPath)
    assert.equal(reread.meta().growthSinceCuration, 3)
    assert.equal(reread.meta().lastCurationAt, 1_700_000_000)
    assert.equal(reread.all().length, 1, '记录不能因为改 meta 丢掉')
    const raw = JSON.parse(readFileSync(metaPath, 'utf8'))
    assert.equal(raw.meta.growthSinceCuration, 3)
  })
})

describe('similarity and expiry', () => {
  const now = new Date(2026, 9, 24, 12, 0, 0).getTime()

  it('scores same-topic entries higher than unrelated ones', () => {
    const left = normalize({ title: '向量检索', content: 'bge-small-zh 建索引', keywords: ['向量', '检索'] })
    const same = normalize({ title: '向量检索', content: '换用 sqlite 做向量索引', keywords: ['向量'] })
    const other = normalize({ title: '生日', content: '他 3 月 12 日生日', keywords: ['生日'] })
    assert.ok(similarity(left, same) > similarity(left, other))
    assert.ok(similarity(left, same) >= 0.3)
  })

  it('lists nearest neighbours by similarity, newest or oldest alike', () => {
    const target = normalize({ title: '向量检索', content: '用 bge 建索引', keywords: ['向量', '索引'], position: 5 })
    const oldSame = normalize({ title: '向量检索', content: '用 bge 建索引的旧方案', keywords: ['向量'], position: 1 })
    const unrelated = normalize({ title: '生日', content: '他 3 月 12 日生日', position: 9 })
    const near = similarEntries([target, oldSame, unrelated], target, { limit: 3 })
    assert.deepEqual(near.map(hit => hit.entry.title), ['向量检索'])
    assert.ok(near[0].score >= 0.3)
  })

  it('accepts a replacement similarity provider (the vector slot)', () => {
    const target = normalize({ title: '无头浏览器', content: 'playwright-core', position: 5 })
    const other = normalize({ title: '浏览器自动化', content: 'puppeteer', position: 6 })
    // 词法看不出来，向量将来应当看得出来；这里验证接缝确实可替换。
    assert.deepEqual(similarEntries([target, other], target), [])
    const near = similarEntries([target, other], target, { similarity: () => 0.9 })
    assert.deepEqual(near.map(hit => hit.entry.title), ['浏览器自动化'])
    assert.equal(near[0].score, 0.9)
  })

  it('accepts a per-pair threshold so vectors and lexical keep their own scales', () => {
    const target = normalize({ title: 'a', content: 'x', position: 5 })
    const entry = normalize({ title: 'b', content: 'y', position: 6 })
    // 词法分数 0.5 在 0.3 阈值下算相近，在向量尺度 0.75 下不算。
    assert.equal(similarEntries([entry], target, { similarity: () => 0.5 }).length, 1)
    assert.equal(similarEntries([entry], target, { similarity: () => 0.5, threshold: () => 0.75 }).length, 0)
  })

  it('penalizes entries whose validity has passed without excluding them', () => {
    const live = normalize({ title: 'x', content: 'x', keywords: ['k'], timestamp: now / 1000, position: 1 })
    const expired = normalize({
      title: 'x',
      content: 'x',
      keywords: ['k'],
      timestamp: now / 1000,
      validTo: '2026-10-01',
      position: 2,
    })
    assert.ok(scoreOf(expired, 'k', now) < scoreOf(live, 'k', now))
    const result = retrieve([expired], 'k', { now })
    assert.equal(result.matches.length, 1, '时效过了仍然可被召回')
  })
})

describe('vector helpers', () => {
  it('builds the embedding text from title, summary and keywords', () => {
    const entry = { title: '向量检索', summary: 'bge 建索引', keywords: ['向量', '索引'] }
    assert.equal(embeddingText(entry), '向量检索\nbge 建索引\n向量\n索引')
  })

  it('changes the fingerprint when any embedded field changes', () => {
    const base = { title: 'a', summary: 'b', keywords: [] }
    assert.equal(embeddingHash(base), embeddingHash({ ...base }))
    assert.notEqual(embeddingHash(base), embeddingHash({ ...base, summary: 'c' }))
  })

  it('computes cosine and refuses mismatched vectors', () => {
    assert.equal(cosine([1, 0], [1, 0]), 1)
    assert.equal(cosine([1, 0], [0, 1]), 0)
    assert.equal(cosine([1, 0], [1, 0, 0]), 0)
    assert.equal(cosine([], []), 0)
  })

  it('prefers vectors over lexical and falls back when one side is missing', () => {
    const lexical = () => 0.1
    const a = { title: 'x', embedding: [1, 0] }
    const b = { title: 'y', embedding: [0.6, 0.8] }
    assert.equal(entrySimilarity(a, b, lexical), 0.6)
    assert.equal(entrySimilarity(a, { title: 'z' }, lexical), 0.1)
  })

  it('only counts a vector as fresh when model, version and hash all match', () => {
    const entry = { title: 'a', summary: 'b', keywords: [], embedding: [0.1], embeddingVersion: 1 }
    const fresh = {
      ...entry,
      embeddingModel: 'Xenova/bge-base-zh-v1.5',
      embeddingHash: embeddingHash(entry),
    }
    assert.equal(embeddingFresh(fresh, 'Xenova/bge-base-zh-v1.5'), true)
    assert.equal(embeddingFresh(fresh, 'other-model'), false)
    assert.equal(embeddingFresh({ ...fresh, embeddingVersion: 0 }, 'Xenova/bge-base-zh-v1.5'), false)
    assert.equal(embeddingFresh({ ...fresh, summary: 'changed' }, 'Xenova/bge-base-zh-v1.5'), false)
  })
})

describe('the "same subject" rule', () => {
  const skillA = normalize({ kind: 'skill', title: 'a', content: 'x', keywords: ['向量', '检索'] })
  const skillB = normalize({ kind: 'skill', title: 'b', content: 'y', keywords: ['向量'] })
  const factA = normalize({ kind: 'fact', title: 'c', content: 'z', keywords: ['向量'] })

  it('matches keywords case-insensitively and bails on empty terms', () => {
    assert.equal(shareTerms({ keywords: ['DSH'] }, { keywords: ['dsh'] }), true)
    assert.equal(shareTerms({ keywords: [] }, { keywords: ['dsh'] }), false)
    assert.equal(shareTerms({ keywords: ['dsh'], tags: ['工具'] }, { tags: ['工具'] }), true)
  })

  it('never pairs different kinds, however similar the text', () => {
    assert.equal(likelySameSubject(skillA, factA, 0.95), false)
  })

  it('needs a shared term before trusting a merely high score', () => {
    // 真实数据里"同领域不同事"的余弦是 0.82–0.89，单凭 0.85 不够。
    const unrelated = normalize({ kind: 'skill', title: 'x', content: 'y', keywords: ['路径'] })
    assert.equal(likelySameSubject(unrelated, skillA, 0.85), false)
  })

  it('accepts a shared term above the floor and near-duplicates outright', () => {
    assert.equal(likelySameSubject(skillA, skillB, 0.8), true)
    assert.equal(likelySameSubject(skillA, skillB, 0.5), false)
    const noTerms = normalize({ kind: 'skill', title: 'x', content: 'y' })
    assert.equal(likelySameSubject(noTerms, { kind: 'skill', title: 'x', content: 'y' }, 0.95), true)
  })

  it('accepts a scale-aware floor so lexical and vectors keep their own bar', () => {
    assert.equal(likelySameSubject(skillA, skillB, 0.4, { threshold: () => 0.3 }), true)
    assert.equal(likelySameSubject(skillA, skillB, 0.4, { threshold: () => 0.75 }), false)
  })

  it('filters a candidate set down to the same subject', () => {
    const unrelated = normalize({ kind: 'skill', title: 'x', content: 'y', keywords: ['路径'] })
    const hits = sameSubjectEntries([skillB, unrelated, factA], skillA, {
      similarity: () => 0.85,
      threshold: () => 0.75,
    })
    assert.deepEqual(hits.map(hit => hit.entry.title), ['b'])
  })

  it('does not drop a real match that ranks low before filtering', () => {
    // 15 条无关条目拿更高的原始分，真正的同类排在最后。先截断 12 条就会丢掉它。
    const noise = Array.from({ length: 15 }, (_, index) => normalize({
      kind: 'skill',
      title: `noise-${index}`,
      content: 'z',
      keywords: [`noise${index}`],
      position: index,
    }))
    const target = normalize({ kind: 'skill', title: 'target', content: 'x', keywords: ['向量'] })
    const real = normalize({ kind: 'skill', title: 'real', content: 'y', keywords: ['向量'], position: 99 })
    const hits = sameSubjectEntries([...noise, real], target, {
      // 噪声分更高但不共用关键词（且低于近似重复线 0.93），真匹配分低却共用关键词。
      similarity: (left) => (left.title === 'real' ? 0.8 : 0.85),
      threshold: () => 0.75,
    })
    assert.deepEqual(hits.map(hit => hit.entry.title), ['real'])
  })
})

describe('retrieval', () => {
  const now = new Date(2026, 9, 24, 12, 0, 0).getTime()
  const entries = [
    normalize({ kind: 'self', title: '我立的界', content: '带权限的新能力，先划范围', timestamp: now / 1000 - 60 }),
    normalize({
      kind: 'skill',
      title: '向量检索',
      content: 'bge-small-zh + sqlite 做块检索',
      keywords: ['向量', '检索'],
      timestamp: now / 1000 - 3600,
      position: 2,
    }),
    normalize({
      kind: 'fact',
      title: '生日',
      content: '他 3 月 12 日生日',
      keywords: ['生日'],
      timestamp: now / 1000 - 86400 * 200,
      position: 3,
    }),
  ]

  it('always returns resident entries and only scores the rest', () => {
    const result = retrieve(entries, '我想做个向量检索的东西', { now })
    assert.equal(result.anchors.length, 1)
    assert.equal(result.anchors[0].title, '我立的界')
    assert.equal(result.matches[0].title, '向量检索')
  })

  // 标题原来完全不参与打分：中文没有空格，"查询包含关键词"的精确判断在自然语言
  // 提问里几乎不成立，于是 10 条库一句正常提问只捞得出 1 条。
  it('credits a title that shares characters with the query', () => {
    const strong = normalize({ kind: 'fact', title: '部署到 profile 里', content: 'x', timestamp: now / 1000 })
    const weak = normalize({ kind: 'fact', title: 'profile', content: 'x', timestamp: now / 1000 })
    const query = '怎么装到 profile 里'
    const gap = scoreOf(strong, query, now) - scoreOf(weak, query, now)
    assert.ok(gap > 0, '重合越多分越高')
    assert.ok(gap <= 2, `标题最多加 2 分，不能盖过关键词命中（实际 ${gap}）`)
  })

  it('never recalls an entry with no lexical evidence at all', () => {
    // 新鲜度和重要度只该在"这批相关条目里"排序，不该让无关条目凭这两项上位。
    const fresh = normalize({ kind: 'fact', title: '今天天气', content: 'x', important: 1000, timestamp: now / 1000 })
    assert.equal(scoreOf(fresh, '她该叫什么名字', now), 0)
    assert.deepEqual(retrieve([fresh], '她该叫什么名字', { now }).matches, [])
  })

  it('does not treat one shared function-word bigram as evidence', () => {
    // "什么" 出现在两边不代表讲的是同一件事；重合约 0.16，低于 0.25 的下限。
    const entry = normalize({ kind: 'fact', title: '相似阈值为什么是 0.75', content: 'x', timestamp: now / 1000 })
    assert.equal(scoreOf(entry, '她该叫什么名字', now), 0)
  })

  it('recalls an entry whose title matches even without keyword hits', () => {
    const titled = normalize({ kind: 'fact', title: '部署到 profile 里', content: 'x', timestamp: now / 1000 })
    const other = normalize({ kind: 'fact', title: '无关标题', content: 'x', timestamp: now / 1000, position: 2 })
    const result = retrieve([titled, other], '怎么装到 profile 里', { now })
    assert.deepEqual(result.matches.map(entry => entry.title), ['部署到 profile 里'])
  })

  it('drops entries below the score floor', () => {
    const result = retrieve(entries, '今天天气如何', { now })
    assert.deepEqual(result.matches, [])
    assert.equal(result.anchors.length, 1)
  })

  it('decays by age and rewards promises', () => {
    const fresh = normalize({ kind: 'fact', title: 'f', content: 'x', timestamp: now / 1000, position: 10 })
    const stale = normalize({ kind: 'fact', title: 's', content: 'x', timestamp: now / 1000 - 86400 * 200, position: 11 })
    assert.ok(scoreOf(fresh, 'x', now) > scoreOf(stale, 'x', now))
    const promise = normalize({ kind: 'promise', title: 'p', content: 'x', timestamp: now / 1000, position: 12 })
    assert.ok(scoreOf(promise, 'x', now) > scoreOf(fresh, 'x', now))
  })

  it('renders resident first, then matches with ids, within the budget', () => {
    const result = retrieve(entries, '向量检索', { now })
    const block = renderMemoryBlock(result, { maxChars: 1000 })
    assert.match(block, /^## 记忆\n### 长期有效\n- 我立的界：/)
    assert.match(block, /### 相关\n- \[mem_[0-9a-f]{16}\] 向量检索：/)
  })

  it('returns an empty block when there is nothing to show', () => {
    assert.equal(renderMemoryBlock({ anchors: [], matches: [] }), '')
  })

  it('drops a section that does not fit the budget entirely', () => {
    const result = retrieve(entries, '向量检索', { now })
    assert.equal(renderMemoryBlock(result, { maxChars: 30 }), '')
  })
})
