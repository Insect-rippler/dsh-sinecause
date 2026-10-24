import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { ACTIONS, apply, inWorkspace, inject, name } from '../src/index.js'

/**
 * 最小 ctx：记录 agent/created 监听器，并给每个 Agent 一个假 scope。
 * 真实的 Cordis 会用 agent.ctx 承载注册，这里等价复现。
 */
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
    logger: { warn() {} },
    listeners,
  }
}

/** 造一个 Agent：cwd 决定它是否落在工作区里。 */
function fakeAgent(cwd) {
  const tools = []
  const contexts = []
  return {
    session: { header: { cwd } },
    ctx: {
      tools: { register: definition => { tools.push(definition); return () => {} } },
      systemPrompt: { context: contribution => { contexts.push(contribution); return () => {} } },
    },
    registered: tools,
    contexts,
  }
}

/** 跑一次 apply，并让给定 cwd 的 Agent 被创建。默认把工作区设成它的 cwd。 */
function mount(config, cwd) {
  const ctx = fakeCtx()
  apply(ctx, { workspaceRoot: cwd, ...config })
  const agent = fakeAgent(cwd)
  ctx.listeners.get('agent/created')?.({ agent })
  return agent
}

let root
let statePath
let workspace

before(() => {
  root = mkdtempSync(join(tmpdir(), 'goal-agenda-plugin-'))
  statePath = join(root, 'agenda.json')
  workspace = join(root, 'workspace')
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('plugin wiring', () => {
  it('declares the services it needs', () => {
    assert.equal(name, 'sinecause-goal')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
  })

  it('registers one plan tool and one tail context per eligible agent', () => {
    const agent = mount({ statePath }, workspace)
    assert.deepEqual(agent.registered.map(tool => tool.name), ['plan'])
    assert.deepEqual(agent.contexts.map(contribution => contribution.name), ['goal:agenda'])
    assert.equal(agent.contexts[0].interpolate, false)
    assert.ok(agent.contexts[0].order > 210, '尾部 context 要排在所有内建 context 之后')
    assert.deepEqual(agent.registered[0].parameters.properties.action.enum, ACTIONS)
  })

  it('stays out of sessions outside workspaceRoot', () => {
    const config = { statePath, workspaceRoot: workspace }
    const outside = mount(config, join(root, 'elsewhere'))
    assert.deepEqual(outside.registered, [])
    assert.deepEqual(outside.contexts, [])
    const inside = mount(config, join(workspace, 'plugin'))
    assert.equal(inside.registered.length, 1)
  })

  it('resolves defaults instead of demanding a state path', () => {
    // 不给路径也能加载：默认取工作区根与 <workspace>/state/agenda.json。
    const agent = mount({}, workspace)
    assert.equal(agent.registered.length, 1)
  })

  it('fails at load on invalid configuration', () => {
    assert.throws(() => apply(fakeCtx(), { statePath: 'relative/agenda.json' }), /statePath/)
    assert.throws(() => apply(fakeCtx(), { workspaceRoot: 'nope' }), /workspaceRoot/)
    assert.throws(() => apply(fakeCtx(), { statePath, maxGoalsShown: 0 }), /maxGoalsShown/)
    assert.throws(() => apply(fakeCtx(), { statePath, maxActive: 0 }), /maxActive/)
  })
})

describe('workspace gate', () => {
  it('matches the root and its descendants only', () => {
    assert.equal(inWorkspace('C:\\a\\b', 'C:\\a\\b'), true)
    assert.equal(inWorkspace(`C:\\a\\b${sep}plugin`, 'C:\\a\\b'), true)
    assert.equal(inWorkspace('C:\\a\\bc', 'C:\\a\\b'), false)
    assert.equal(inWorkspace(undefined, 'C:\\a\\b'), false)
    assert.equal(inWorkspace('C:\\anything', undefined), true)
  })
})

describe('plan tool', () => {
  it('creates a plan and answers with the rendered tail', async () => {
    const agent = mount({ statePath }, workspace)
    const [tool] = agent.registered
    const result = await tool.execute({
      action: 'create',
      objective: '把观察攒起来',
      steps: ['翻记录', '写一段'],
    })
    assert.match(result.agenda, /## 目标与计划/)
    assert.match(result.agenda, /把观察攒起来（g_\d+）· 共 2 步（完成 0 · 可推进 2）/)
    assert.match(result.agenda, /\[>\] 1\. 翻记录（当前）/)
    assert.deepEqual(tool.output.render({}, result), [{ type: 'text', text: result.agenda }])
  })

  it('advances a step and shows the new current one', async () => {
    const agent = mount({ statePath }, workspace)
    const [tool] = agent.registered
    const result = await tool.execute({ action: 'done', step_id: 1, evidence: '翻到三条' })
    assert.match(result.agenda, /\[x\] 1\. 翻记录（证据：翻到三条）/)
    assert.match(result.agenda, /\[>\] 2\. 写一段（当前）/)
  })

  it('surfaces state errors to the model', async () => {
    const agent = mount({ statePath }, workspace)
    const [tool] = agent.registered
    await assert.rejects(() => tool.execute({ action: 'done', step_id: 99 }), /找不到第 99 步/)
    await assert.rejects(() => tool.execute({ action: 'nope' }), /action 只支持/)
  })

  it('refuses to run after the session leaves the workspace', async () => {
    const config = { statePath, workspaceRoot: workspace }
    const agent = mount(config, workspace)
    const [tool] = agent.registered
    agent.session.header.cwd = join(root, 'elsewhere')
    await assert.rejects(() => tool.execute({ action: 'list' }), /只在这个工作区的会话里可用/)
  })

  it('lists without an active plan without throwing', async () => {
    const agent = mount({ statePath: join(root, 'empty.json') }, workspace)
    const [tool] = agent.registered
    const result = await tool.execute({ action: 'list' })
    assert.equal(result.agenda, '## 目标与计划\n当前没有目标，需要寻找新的目标。')
  })
})

describe('tail context', () => {
  it('renders the current agenda', async () => {
    const agent = mount({ statePath }, workspace)
    const text = agent.contexts[0].text({})
    assert.match(text, /## 目标与计划/)
    assert.match(text, /写一段（当前）/)
  })

  it('renders nothing outside the workspace', () => {
    const config = { statePath, workspaceRoot: workspace }
    const agent = mount(config, workspace)
    agent.session.header.cwd = join(root, 'elsewhere')
    assert.equal(agent.contexts[0].text({}), '')
  })

  it('degrades to an empty agenda when the state file is missing', () => {
    const agent = mount({ statePath: join(root, 'nested-dir', 'agenda.json') }, workspace)
    assert.match(agent.contexts[0].text({}), /当前没有目标/)
  })
})
