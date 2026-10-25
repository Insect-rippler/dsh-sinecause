import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { pickTarget } from '../src/clock/decide.js'
import { HeartbeatStore } from '../src/clock/heartbeat-store.js'
import { createRegistry, runTick } from '../src/clock/index.js'

const MINUTE = 60_000
const workspace = 'C:/work/sinecause'

/** 一个够用的假 Agent：只记 followup。 */
function fakeAgent(id, cwd) {
  const followed = []
  return {
    id,
    session: { header: { cwd }, id },
    followed,
    followup(message) {
      followed.push(message)
    },
  }
}

function registryWith(startAt, ...agents) {
  const registry = createRegistry()
  for (const agent of agents) {
    registry.track(String(agent.id), agent, agent.session.header.cwd)
    // track 会把活跃时间设成"现在"；测试要可控的时间轴，所以显式推回去。
    registry.touch(String(agent.id), startAt)
  }
  return registry
}

describe('HeartbeatStore', () => {
  it('remembers a threshold across a reload', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'beat-')), 'heartbeat.json')
    const store = new HeartbeatStore(path)
    assert.equal(store.get('s1'), undefined)

    store.set('s1', 90 * MINUTE, 1_000)
    assert.equal(store.get('s1').idleMs, 90 * MINUTE)

    // 换一个实例读同一个文件：重启之后还没着的等待不该消失。
    assert.equal(new HeartbeatStore(path).get('s1').idleMs, 90 * MINUTE)
  })

  it('clears one session without touching the others', () => {
    const store = new HeartbeatStore(join(mkdtempSync(join(tmpdir(), 'beat-')), 'heartbeat.json'))
    store.set('a', MINUTE)
    store.set('b', 2 * MINUTE)
    store.clear('a')
    assert.equal(store.get('a'), undefined)
    assert.equal(store.get('b').idleMs, 2 * MINUTE)
  })

  it('does not write the file when there is nothing to clear', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beat-'))
    const path = join(dir, 'heartbeat.json')
    const store = new HeartbeatStore(path)
    store.clear('nobody')
    assert.equal(existsSync(path), false, '没有门槛就不该创建文件')

    store.set('a', MINUTE)
    const before = statSync(path).mtimeMs
    store.clear('a')
    assert.equal(store.get('a'), undefined)
    assert.ok(statSync(path).mtimeMs >= before)
  })
  it('treats a corrupt file as no thresholds at all', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'beat-')), 'heartbeat.json')
    writeFileSync(path, '{ 这不是 JSON', 'utf8')
    const store = new HeartbeatStore(path)
    assert.deepEqual(store.all(), {})
    // 坏文件不该让写入也坏掉。
    store.set('s1', MINUTE)
    assert.equal(store.get('s1').idleMs, MINUTE)
  })

  it('ignores records that make no sense', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'beat-')), 'heartbeat.json')
    writeFileSync(path, JSON.stringify({ entries: { bad: { idleMs: -5 }, worse: { idleMs: 'x' } } }), 'utf8')
    assert.deepEqual(new HeartbeatStore(path).all(), {})
  })
})

describe('per-session threshold', () => {
  it('lets one session raise its own bar above the default', () => {
    const agents = [
      { id: 'slow', lastActivity: 0, busy: false, minIdleMs: 120 * MINUTE },
      { id: 'normal', lastActivity: 0, busy: false },
    ]
    // 都安静了 30 分钟：默认门槛 10 分钟，只有没设门槛的那个该醒。
    assert.equal(pickTarget(agents, { now: 30 * MINUTE, minIdleMs: 10 * MINUTE }), 'normal')
    // 到了两小时，两个都够久，取最近活跃的——此时并列，稳定取前者。
    assert.equal(pickTarget(agents, { now: 130 * MINUTE, minIdleMs: 10 * MINUTE }), 'slow')
  })

  it('does not wake a session that asked to be left alone', () => {
    const agent = fakeAgent('s1', workspace)
    const registry = registryWith(0, agent)
    const sent = []
    runTick(registry, {
      now: 30 * MINUTE,
      intervalMs: 10 * MINUTE,
      workspaceRoot: workspace,
      minIdleMsOf: () => 120 * MINUTE,
      send: (_agent, text) => sent.push(text),
    })
    assert.equal(sent.length, 0, '设了 2 小时就不该在第 30 分钟被叫')
  })
})

describe('running a tick with an override', () => {
  it('wakes once the override is met and then drops back to the default', () => {
    const agent = fakeAgent('s1', workspace)
    const registry = registryWith(0, agent)
    const sent = []
    const cleared = []
    const options = {
      now: 130 * MINUTE,
      intervalMs: 10 * MINUTE,
      workspaceRoot: workspace,
      minIdleMsOf: () => 120 * MINUTE,
      clearOverride: id => cleared.push(id),
      send: (_agent, text) => sent.push(text),
    }

    assert.equal(runTick(registry, options), 's1')
    assert.equal(sent.length, 1)
    assert.match(sent[0], /心跳/)
    assert.deepEqual(cleared, ['s1'], '醒过一次就该回到默认节拍')
  })

  it('leaves the override alone when nobody is eligible', () => {
    const agent = fakeAgent('s1', workspace)
    const registry = registryWith(0, agent)
    const cleared = []
    runTick(registry, {
      now: 5 * MINUTE,
      intervalMs: 10 * MINUTE,
      workspaceRoot: workspace,
      minIdleMsOf: () => 120 * MINUTE,
      clearOverride: id => cleared.push(id),
      send: () => {},
    })
    assert.deepEqual(cleared, [], '没叫醒就不该清门槛')
  })
})
