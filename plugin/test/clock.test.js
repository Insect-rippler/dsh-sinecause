import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_PROMPT,
  clockText,
  idleText,
  pickTarget,
  renderTick,
  shouldWake,
} from '../src/clock/decide.js'
import { apply, createRegistry, heartbeatMessage, runTick } from '../src/clock/index.js'

const MINUTE = 60_000

describe('shouldWake', () => {
  it('only wakes an idle agent past the interval', () => {
    const base = { now: 10 * MINUTE, intervalMs: 5 * MINUTE }
    assert.equal(shouldWake({ ...base, lastActivity: 0, busy: false }), true)
    assert.equal(shouldWake({ ...base, lastActivity: 6 * MINUTE, busy: false }), false)
    assert.equal(shouldWake({ ...base, lastActivity: 0, busy: true }), false)
    assert.equal(shouldWake({ ...base, lastActivity: Number.NaN, busy: false }), false)
  })
})

describe('pickTarget', () => {
  it('prefers the most recently active eligible agent', () => {
    const agents = [
      { id: 'old', lastActivity: 0, busy: false },
      { id: 'recent', lastActivity: 9 * MINUTE, busy: false },
      { id: 'busy', lastActivity: 9 * MINUTE, busy: true },
    ]
    assert.equal(pickTarget(agents, { now: 20 * MINUTE, intervalMs: 5 * MINUTE }), 'recent')
  })

  it('returns nothing when everyone is busy or fresh', () => {
    const agents = [
      { id: 'busy', lastActivity: 0, busy: true },
      { id: 'fresh', lastActivity: 19 * MINUTE, busy: false },
    ]
    assert.equal(pickTarget(agents, { now: 20 * MINUTE, intervalMs: 5 * MINUTE }), undefined)
  })
})

describe('rendering', () => {
  const now = new Date(2026, 9, 24, 21, 12, 0).getTime()

  it('formats the clock and the idle span', () => {
    assert.equal(clockText(now), '21:12')
    assert.equal(idleText(18 * MINUTE), '18 分钟')
    assert.equal(idleText(2 * 60 * MINUTE), '2 小时')
    assert.equal(idleText(125 * MINUTE), '2 小时 5 分')
  })

  it('fills the default prompt', () => {
    const text = renderTick({ now, idleMs: 18 * MINUTE })
    assert.match(text, /现在是 21:12/)
    assert.match(text, /已经 18 分钟/)
    assert.match(text, /memory curate/)
  })

  it('fills a custom prompt and leaves unknown placeholders alone', () => {
    const text = renderTick({ now, idleMs: 18 * MINUTE, prompt: '{{now}} / {{idle}} / {{unknown}}' })
    assert.equal(text, '21:12 / 18 分钟 / {{unknown}}')
  })

  it('keeps the default prompt stable enough to be worth documenting', () => {
    assert.match(DEFAULT_PROMPT, /\{\{now\}\}/)
    assert.match(DEFAULT_PROMPT, /\{\{idle\}\}/)
  })
})

describe('the heartbeat message', () => {
  it('is a user message marked as context, so recall skips it as a query', () => {
    const message = heartbeatMessage('心跳')
    assert.equal(message.role, 'user')
    assert.deepEqual(message.content, [{ type: 'text', text: '心跳' }])
    assert.equal(message.source.kind, 'sinecause-clock')
    assert.equal(message.source.form, 'notice')
  })

  it('carries a unique id because the inbox deduplicates by id', () => {
    const first = heartbeatMessage('a')
    const second = heartbeatMessage('b')
    assert.match(first.id, /^[0-9a-f-]{36}$/)
    assert.notEqual(first.id, second.id)
  })
})

describe('plugin wiring', () => {
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
      effect() {
        return () => {}
      },
      logger: { warn() {} },
      listeners,
    }
  }

  /** 一个只记录 followup / inbox.append 的假 Agent。 */
  function fakeAgent(cwd, origin) {
    const followed = []
    const appended = []
    const id = origin === undefined ? `session-${cwd}` : `session-${cwd}-${origin}`
    return {
      id,
      session: {
        header: { cwd, ...origin === undefined ? {} : { origin } },
        id,
      },
      followed,
      appended,
      followup(message) {
        followed.push(message)
      },
      inbox: {
        append(target, message) {
          appended.push({ target, message })
        },
      },
    }
  }

  /** 装好插件并创建一个指定 cwd 的 Agent。 */
  function mountWith(config, cwd, origin) {
    const ctx = fakeCtx()
    apply(ctx, config)
    const agent = fakeAgent(cwd, origin)
    ctx.listeners.get('agent/created')({ agent })
    return { ctx, agent }
  }

  it('wakes through followup, because a bare inbox append never starts a turn', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 })
    const { agent } = mountWith({ intervalMinutes: 5, workspaceRoot: 'C:/work/sinecause' }, 'C:/work/sinecause')

    t.mock.timers.tick(6 * 60_000)

    assert.equal(agent.followed.length, 1)
    assert.equal(agent.appended.length, 0, '只入队不叫醒等于没叫')
    assert.match(agent.followed[0].content[0].text, /心跳/)
  })

  it('does not wake while the agent is running', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 })
    const { ctx, agent } = mountWith({ intervalMinutes: 5, workspaceRoot: 'C:/work/sinecause' }, 'C:/work/sinecause')
    ctx.listeners.get('agent/status')({ agent, status: 'running' })

    t.mock.timers.tick(6 * 60_000)
    assert.equal(agent.followed.length, 0)
  })

  it('does not wake a session outside the workspace', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 })
    const { agent } = mountWith({ intervalMinutes: 5, workspaceRoot: 'C:/work/sinecause' }, 'C:/elsewhere')

    t.mock.timers.tick(6 * 60_000)
    assert.equal(agent.followed.length, 0)
  })

  it('never wakes a subagent, even inside the workspace', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 })
    const { agent } = mountWith(
      { intervalMinutes: 5, workspaceRoot: 'C:/work/sinecause' },
      'C:/work/sinecause',
      'subagent',
    )

    t.mock.timers.tick(6 * 60_000)
    assert.equal(agent.followed.length, 0, '子代理是她的工具，不是她本人')
  })

  it('rejects invalid configuration at load', () => {
    assert.throws(() => apply(fakeCtx(), { intervalMinutes: 0 }), /intervalMinutes/)
    assert.throws(() => apply(fakeCtx(), { intervalMinutes: Number.NaN }), /intervalMinutes/)
    assert.throws(() => apply(fakeCtx(), { workspaceRoot: 'relative/path' }), /workspaceRoot/)
    assert.throws(() => apply(fakeCtx(), { prompt: 42 }), /prompt/)
  })
})

describe('runTick', () => {
  const workspace = 'C:/work/sinecause'
  const outside = 'C:/elsewhere'

  function setup() {
    const registry = createRegistry()
    const sent = []
    const warnings = []
    registry.track('inside', { id: 'inside' }, workspace)
    registry.track('outside', { id: 'outside' }, outside)
    return { registry, sent, warnings }
  }

  it('wakes the workspace agent and pushes its activity forward', () => {
    const { registry, sent } = setup()
    registry.touch('inside', 0)
    registry.touch('outside', 0)
    const woke = runTick(registry, {
      now: 20 * MINUTE,
      intervalMs: 5 * MINUTE,
      workspaceRoot: workspace,
      send: (agent, text) => sent.push({ id: agent.id, text }),
    })
    assert.equal(woke, 'inside')
    assert.equal(sent.length, 1)
    assert.ok(sent[0].text.includes(clockText(20 * MINUTE)))
    assert.match(sent[0].text, /20 分钟/)
    assert.equal(registry.get('inside').lastActivity, 20 * MINUTE)
  })

  it('never wakes a session outside the workspace', () => {
    const { registry, sent } = setup()
    registry.touch('inside', 19 * MINUTE)
    registry.touch('outside', 0)
    const woke = runTick(registry, {
      now: 20 * MINUTE,
      intervalMs: 5 * MINUTE,
      workspaceRoot: workspace,
      send: (agent, text) => sent.push({ id: agent.id, text }),
    })
    assert.equal(woke, undefined)
    assert.equal(sent.length, 0)
  })

  it('keeps ticking after a failed wake', () => {
    const { registry, warnings } = setup()
    registry.touch('inside', 0)
    const woke = runTick(registry, {
      now: 20 * MINUTE,
      intervalMs: 5 * MINUTE,
      workspaceRoot: workspace,
      send: () => { throw new Error('inbox closed') },
      warn: message => warnings.push(message),
    })
    assert.equal(woke, 'inside')
    assert.match(warnings[0], /inbox closed/)
    // 失败也推进活跃时间，否则每一跳都会重试同一个死会话。
    assert.equal(registry.get('inside').lastActivity, 20 * MINUTE)
  })
})
