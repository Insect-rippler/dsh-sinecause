import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { MemoryStore } from '../src/memory/store.js'
import { ACTIONS, apply, inWorkspace, inject, lastUserText, name } from '../src/memory/index.js'

/** 最小 ctx：记录 agent/created 监听器。 */
function fakeCtx() {
  const listeners = new Map()
  return {
    on(event, listener) {
      listeners.set(event, listener)
      return () => {}
    },
    get() {
      return undefined
    },
    listeners,
  }
}

/** 造一个 Agent：cwd 决定它是否落在工作区里。 */
function fakeAgent(cwd) {
  const tools = []
  const contexts = []
  const agent = {
    id: `session-${cwd}`,
    session: { header: { cwd } },
    ctx: {
      tools: { register: definition => { tools.push(definition); return () => {} } },
      // 记忆挂在"请求末尾"：模拟 llm/stream，跑一遍钩子，把追加的那条消息取出来。
      on(event, handler) {
        if (event !== 'llm/stream') return () => {}
        const run = () => {
          const options = { sessionId: agent.id, messages: [] }
          handler(options, () => options)
          const last = options.messages[options.messages.length - 1]
          return last === undefined ? '' : last.content.map(part => part.text).join('\n')
        }
        contexts.push({ text: () => run() })
        return () => {}
      },
    },
    registered: tools,
    contexts,
  }
  return agent
}

/** 跑一次 apply，并让给定 cwd 的 Agent 被创建。默认关掉向量、工作区设成该 cwd。 */
function mount(config, cwd) {
  const ctx = fakeCtx()
  apply(ctx, { embedding: { enabled: false }, workspaceRoot: cwd, ...config })
  const agent = fakeAgent(cwd)
  ctx.listeners.get('agent/created')?.({ agent })
  return agent
}

let root
let statePath
let workspace

before(() => {
  root = mkdtempSync(join(tmpdir(), 'sinecause-memory-plugin-'))
  statePath = join(root, 'memory.json')
  workspace = join(root, 'workspace')
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('memory plugin wiring', () => {
  it('declares the services it needs', () => {
    assert.equal(name, 'sinecause-memory')
    assert.deepEqual(inject, ['tools', 'systemPrompt', 'llm'], 'llm 必须声明：不注入就收不到 llm/stream')
  })

  it('registers one memory tool and one context, ordered before goal', () => {
    const agent = mount({ statePath }, workspace)
    assert.deepEqual(agent.registered.map(tool => tool.name), ['memory'])
    // 请求时组装：内容为空时不产出 section，所以只断言钩子挂上了。
    // 顺序由 goal 那条测试覆盖（那边有内容，能看到 order）。
    assert.equal(agent.contexts.length, 1)
    assert.deepEqual(agent.registered[0].parameters.properties.action.enum, ACTIONS)
  })

  it('stays out of sessions outside workspaceRoot', () => {
    const config = { statePath, workspaceRoot: workspace }
    const outside = mount(config, join(root, 'elsewhere'))
    assert.deepEqual(outside.registered, [])
    assert.deepEqual(outside.contexts, [])
  })

  it('resolves defaults instead of demanding a state path', () => {
    const agent = mount({}, workspace)
    assert.equal(agent.registered.length, 1)
  })

  it('fails at load on invalid configuration', () => {
    assert.throws(() => apply(fakeCtx(), { embedding: { enabled: false }, statePath: 'relative/memory.json' }), /statePath/)
    assert.throws(() => apply(fakeCtx(), { embedding: { enabled: false }, workspaceRoot: 'nope' }), /workspaceRoot/)
    assert.throws(() => apply(fakeCtx(), { statePath, maxChars: 0 }), /maxChars/)
    assert.throws(() => apply(fakeCtx(), { statePath, topK: 0 }), /topK/)
  })

  it('matches the root and its descendants only', () => {
    assert.equal(inWorkspace('C:\\a\\b', 'C:\\a\\b'), true)
    assert.equal(inWorkspace('C:\\a\\bc', 'C:\\a\\b'), false)
    assert.equal(inWorkspace('C:\\anything', undefined), true)
  })
})

describe('memory tool', () => {
  it('adds a fact and reports its id', async () => {
    const agent = mount({ statePath }, workspace)
    const [tool] = agent.registered
    const result = await tool.execute({
      action: 'add',
      kind: 'fact',
      title: '生日',
      content: '他 3 月 12 日生日',
      keywords: ['生日'],
    })
    assert.match(result.result, /已记住 \[mem_[0-9a-f]{16}\] fact · 生日/)
    const stored = new MemoryStore(statePath).all()
    assert.equal(stored.length, 1)
    assert.equal(stored[0].content, '他 3 月 12 日生日')
  })

  it('finds a memory by keyword', async () => {
    const agent = mount({ statePath }, workspace)
    const [tool] = agent.registered
    const found = await tool.execute({ action: 'search', query: '他生日是哪天' })
    assert.match(found.result, /\[mem_[0-9a-f]{16}\] fact · 生日/)
    const missing = await tool.execute({ action: 'search', query: '完全无关的查询' })
    assert.equal(missing.result, '（没有匹配的记忆）')
  })

  it('updates and archives by id', async () => {
    const agent = mount({ statePath }, workspace)
    const [tool] = agent.registered
    const [entry] = new MemoryStore(statePath).all()
    const updated = await tool.execute({
      action: 'update',
      id: entry.id,
      fields: { content: '他 3 月 12 日生日，提前一周准备' },
    })
    assert.match(updated.result, /已更新/)
    assert.match(new MemoryStore(statePath).get(entry.id).content, /提前一周/)
    await tool.execute({ action: 'archive', id: entry.id })
    assert.equal(new MemoryStore(statePath).get(entry.id).status, 'archived')
    await assert.rejects(() => tool.execute({ action: 'archive', id: 'mem_nope' }), /找不到记忆/)
  })

  it('rejects an empty add and an unknown action', async () => {
    const agent = mount({ statePath: join(root, 'empty.json') }, workspace)
    const [tool] = agent.registered
    await assert.rejects(() => tool.execute({ action: 'add', title: 'x' }), /add 需要 content/)
    await assert.rejects(() => tool.execute({ action: 'nope' }), /action 只支持/)
    await assert.rejects(() => tool.execute({ action: 'update', id: 'mem_x' }), /update 需要 fields/)
  })

  it('refuses to run after the session leaves the workspace', async () => {
    const config = { statePath, workspaceRoot: workspace }
    const agent = mount(config, workspace)
    const [tool] = agent.registered
    agent.session.header.cwd = join(root, 'elsewhere')
    await assert.rejects(() => tool.execute({ action: 'list' }), /只在这个工作区的会话里可用/)
  })
})

describe('memory context', () => {
  it('injects resident entries and the query-relevant ones', async () => {
    const agent = mount({ statePath }, workspace)
    const [tool] = agent.registered
    await tool.execute({ action: 'add', kind: 'self', title: '我立的界', content: '带权限的新能力先划范围' })
    const text = agent.contexts[0].text({})
    assert.match(text, /### 长期有效\n- 我立的界：/)
  })

  it('renders nothing when the store is empty', () => {
    const agent = mount({ statePath: join(root, 'nothing-here.json') }, workspace)
    assert.equal(agent.contexts[0].text({}), '')
  })

  it('renders nothing outside the workspace', () => {
    const config = { statePath, workspaceRoot: workspace }
    const agent = mount(config, workspace)
    agent.session.header.cwd = join(root, 'elsewhere')
    assert.equal(agent.contexts[0].text({}), '')
  })
})

describe('curation trigger', () => {
  it('counts only growth kinds', async () => {
    const curatePath = join(root, 'growth', 'memory.json')
    const agent = mount({ statePath: curatePath, curationEvery: 3 }, workspace)
    const [tool] = agent.registered
    await tool.execute({ action: 'add', kind: 'skill', title: 's', content: '学了一个框架' })
    await tool.execute({ action: 'add', kind: 'episode', title: 'e', content: '读了一本书' })
    await tool.execute({ action: 'add', kind: 'self', title: 'b', content: '立了一条界' })
    assert.equal(new MemoryStore(curatePath).meta().growthSinceCuration, 2)
  })

  it('warns in the tool result and in the tail once the threshold is reached', async () => {
    const curatePath = join(root, 'threshold', 'memory.json')
    const agent = mount({ statePath: curatePath, curationEvery: 2 }, workspace)
    const [tool] = agent.registered
    const first = await tool.execute({ action: 'add', kind: 'skill', title: 's1', content: '一' })
    assert.doesNotMatch(first.result, /该整理了/)
    const second = await tool.execute({ action: 'add', kind: 'fact', title: 'f1', content: '二' })
    assert.match(second.result, /（积累 2 条，该整理了）/)
    assert.match(agent.contexts[0].text({}), /### 该整理了/)
    assert.match(agent.contexts[0].text({}), /阈值 2/)
  })

  it('lists pending entries and resets the counter', async () => {
    const curatePath = join(root, 'curate', 'memory.json')
    const agent = mount({ statePath: curatePath }, workspace)
    const [tool] = agent.registered
    await tool.execute({ action: 'add', kind: 'skill', title: '尾部注入', content: 'runtime context 会替换旧快照' })
    const pending = await tool.execute({ action: 'curate' })
    assert.match(pending.result, /待整理 1 条/)
    assert.match(pending.result, /\[mem_[0-9a-f]{16}\] skill · 尾部注入/)
    const reset = await tool.execute({ action: 'curate', reset: true })
    assert.match(reset.result, /已复位/)
    assert.equal(new MemoryStore(curatePath).meta().growthSinceCuration, 0)
    const after = await tool.execute({ action: 'curate' })
    assert.match(after.result, /没有待整理的条目/)
  })

  it('keeps the notice out of the tail below the threshold', () => {
    const quiet = mount({ statePath: join(root, 'quiet', 'memory.json'), curationEvery: 5 }, workspace)
    assert.equal(quiet.contexts[0].text({}), '')
  })
})

describe('outdating by similarity', () => {
  it('points at the similar entry already in the store', async () => {
    const path = join(root, 'similar', 'memory.json')
    const agent = mount({ statePath: path }, workspace)
    const [tool] = agent.registered
    await tool.execute({ action: 'add', kind: 'skill', title: '向量检索', content: 'bge-small-zh 建索引', keywords: ['向量'] })
    const newer = await tool.execute({
      action: 'add',
      kind: 'skill',
      title: '向量检索',
      content: '换成 sqlite 做向量索引',
      keywords: ['向量'],
    })
    assert.match(newer.result, /库里相近：\[mem_[0-9a-f]{16}\] 向量检索/)
    assert.match(newer.result, /用 supersede 把旧的让位/)
  })

  it('stays quiet when nothing in the store is close', async () => {
    const path = join(root, 'unrelated', 'memory.json')
    const agent = mount({ statePath: path }, workspace)
    const [tool] = agent.registered
    const result = await tool.execute({ action: 'add', kind: 'fact', title: '生日', content: '他 3 月 12 日生日' })
    assert.doesNotMatch(result.result, /库里相近/)
  })

  it('lists near neighbours inside the curation list', async () => {
    const path = join(root, 'curate-neighbours', 'memory.json')
    const agent = mount({ statePath: path }, workspace)
    const [tool] = agent.registered
    await tool.execute({ action: 'add', kind: 'skill', title: '向量检索', content: 'bge-small-zh 建索引', keywords: ['向量'] })
    await tool.execute({ action: 'add', kind: 'skill', title: '向量检索', content: '改成 sqlite 索引', keywords: ['向量'] })
    const listed = await tool.execute({ action: 'curate' })
    assert.match(listed.result, /~ 相近：\[mem_[0-9a-f]{16}\] 向量检索/)
    assert.match(listed.result, /supersede/)
  })
})

describe('outdating by expiry', () => {
  it('lowers importance and dates the entry without hiding it', async () => {
    const path = join(root, 'expire', 'memory.json')
    const agent = mount({ statePath: path }, workspace)
    const [tool] = agent.registered
    const added = await tool.execute({
      action: 'add',
      kind: 'fact',
      title: '发布会',
      content: '他周五要开发布会',
      important: 500,
    })
    const id = /\[(mem_[0-9a-f]{16})\]/.exec(added.result)[1]
    const expired = await tool.execute({ action: 'expire', id })
    assert.match(expired.result, /已按时效降权/)
    const stored = new MemoryStore(path).get(id)
    assert.equal(stored.status, 'active', '降权不是隐藏')
    assert.match(stored.validTo, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(stored.important, 150)
  })

  it('rejects an unknown id', async () => {
    const path = join(root, 'expire-missing', 'memory.json')
    const agent = mount({ statePath: path }, workspace)
    const [tool] = agent.registered
    await assert.rejects(() => tool.execute({ action: 'expire', id: 'mem_nope' }), /找不到记忆/)
  })
})

describe('removing stale memory', () => {
  it('supersedes an outdated entry and records where it went', async () => {
    const path = join(root, 'supersede', 'memory.json')
    const agent = mount({ statePath: path }, workspace)
    const [tool] = agent.registered
    const old = await tool.execute({ action: 'add', kind: 'fact', title: '模型', content: '他用 v1' })
    const fresh = await tool.execute({ action: 'add', kind: 'fact', title: '模型', content: '他换到 v2 了' })
    const oldId = /\[(mem_[0-9a-f]{16})\]/.exec(old.result)[1]
    const freshId = /\[(mem_[0-9a-f]{16})\]/.exec(fresh.result)[1]
    const marked = await tool.execute({ action: 'supersede', id: oldId, by: freshId })
    assert.match(marked.result, /标记为过时/)
    assert.match(marked.result, new RegExp(`由 \\[${freshId}\\] 取代`))
    const store = new MemoryStore(path)
    assert.equal(store.get(oldId).status, 'superseded')
    assert.match(store.get(oldId).validTo, /^\d{4}-\d{2}-\d{2}$/)
    assert.deepEqual(store.get(freshId).supersedes, [oldId])
  })

  it('keeps superseded entries findable through list output but out of the tail', async () => {
    const path = join(root, 'hidden', 'memory.json')
    const agent = mount({ statePath: path }, workspace)
    const [tool] = agent.registered
    const added = await tool.execute({ action: 'add', kind: 'self', title: '旧界', content: '不在晚上干活' })
    const id = /\[(mem_[0-9a-f]{16})\]/.exec(added.result)[1]
    assert.match(agent.contexts[0].text({}), /旧界/)
    await tool.execute({ action: 'archive', id })
    assert.doesNotMatch(agent.contexts[0].text({}), /旧界/)
    await tool.execute({ action: 'restore', id })
    assert.match(agent.contexts[0].text({}), /旧界/)
  })

  it('deletes permanently and reports a missing id afterwards', async () => {
    const path = join(root, 'delete', 'memory.json')
    const agent = mount({ statePath: path }, workspace)
    const [tool] = agent.registered
    const added = await tool.execute({ action: 'add', kind: 'fact', title: '不该留', content: '一次误记' })
    const id = /\[(mem_[0-9a-f]{16})\]/.exec(added.result)[1]
    const removed = await tool.execute({ action: 'delete', id })
    assert.match(removed.result, /已永久删除/)
    assert.equal(new MemoryStore(path).get(id), null)
    await assert.rejects(() => tool.execute({ action: 'delete', id }), /找不到记忆/)
  })

  it('rejects a supersede pointing at a missing successor', async () => {
    const path = join(root, 'supersede-miss', 'memory.json')
    const agent = mount({ statePath: path }, workspace)
    const [tool] = agent.registered
    const added = await tool.execute({ action: 'add', kind: 'fact', title: 'x', content: 'y' })
    const id = /\[(mem_[0-9a-f]{16})\]/.exec(added.result)[1]
    await assert.rejects(() => tool.execute({ action: 'supersede', id, by: 'mem_nope' }), /找不到取代它的记忆/)
  })
})

describe('query extraction', () => {
  it('skips context-formed messages and returns the latest human text', () => {
    const events = [
      { type: 'user/message', data: { content: [{ type: 'text', text: '更早的一句' }], source: { kind: 'user' } } },
      { type: 'user/message', data: { content: [{ type: 'text', text: '上下文注入' }], source: { kind: 'time-context', form: 'snapshot' } } },
      { type: 'assistant/message', data: {} },
      { type: 'user/message', data: { content: [{ type: 'text', text: '最近的一句' }], source: { kind: 'user' } } },
    ]
    const session = { seq: events.length, eventAt: seq => events[seq] }
    assert.equal(lastUserText(session), '最近的一句')
  })

  it('returns an empty string for a session that cannot be read', () => {
    assert.equal(lastUserText({ seq: 3, eventAt: () => { throw new Error('gone') } }), '')
  })
})
