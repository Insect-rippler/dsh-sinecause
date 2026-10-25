import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { apply, resolveWebhook, sendNotification } from '../src/notify/index.js'

const workspace = 'C:/work/sinecause'
const hook = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-hook'

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

function fakeAgent(cwd, origin) {
  const tools = []
  return {
    id: `session-${cwd}`,
    session: { header: { cwd, ...origin === undefined ? {} : { origin } } },
    tools,
    ctx: { tools: { register(spec) { tools.push(spec) } } },
  }
}

function mount(config, cwd, origin) {
  const ctx = fakeCtx()
  apply(ctx, config)
  const agent = fakeAgent(cwd, origin)
  ctx.listeners.get('agent/created')({ agent })
  return { ctx, agent }
}

function tempSettings(payload) {
  const path = join(mkdtempSync(join(tmpdir(), 'notify-')), 'notify.json')
  if (payload !== undefined) writeFileSync(path, JSON.stringify(payload), 'utf8')
  return path
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('resolveWebhook', () => {
  const base = { settingsPath: tempSettings({ feishuWebhook: 'from-file' }) }

  it('prefers the plugin config', () => {
    assert.equal(resolveWebhook({ ...base, webhookUrl: ' from-config ' }, {}), 'from-config')
  })

  it('falls back to the state file, then the environment', () => {
    assert.equal(resolveWebhook({ settingsPath: base.settingsPath }, {}), 'from-file')
    const empty = { settingsPath: tempSettings({}) }
    assert.equal(resolveWebhook(empty, { SINECAUSE_FEISHU_WEBHOOK: 'from-env' }), 'from-env')
  })

  it('returns undefined when nothing is configured', () => {
    assert.equal(resolveWebhook({ settingsPath: tempSettings() }, {}), undefined)
  })
})

describe('sendNotification', () => {
  it('posts a feishu text payload', async () => {
    let captured
    const fetchImpl = async (url, init) => {
      captured = { url, init }
      return { ok: true, json: async () => ({ code: 0, msg: 'success' }) }
    }
    const note = await sendNotification({ webhookUrl: hook, text: '你好', fetchImpl })
    assert.equal(note, '已发送')
    assert.equal(captured.url, hook)
    assert.equal(captured.init.method, 'POST')
    assert.deepEqual(JSON.parse(captured.init.body), { msg_type: 'text', content: { text: '你好' } })
  })

  it('treats a non-zero business code as a failure', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ code: 19021, msg: 'sign match fail' }) })
    await assert.rejects(
      () => sendNotification({ webhookUrl: hook, text: 'x', fetchImpl }),
      /code=19021/,
    )
  })

  it('treats a non-OK HTTP status as a failure', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) })
    await assert.rejects(() => sendNotification({ webhookUrl: hook, text: 'x', fetchImpl }), /HTTP 500/)
  })
})

describe('plugin wiring', () => {
  it('gives workspace sessions a notify tool, and nobody else', () => {
    const inside = mount({ workspaceRoot: workspace, settingsPath: tempSettings({ feishuWebhook: hook }) }, workspace)
    const outside = mount({ workspaceRoot: workspace }, 'C:/elsewhere')
    assert.deepEqual(inside.agent.tools.map(tool => tool.name), ['notify'])
    assert.deepEqual(outside.agent.tools, [])
  })

  it('explains what to configure when the webhook is missing', async () => {
    const settingsPath = tempSettings()
    const { agent } = mount({ workspaceRoot: workspace, settingsPath }, workspace)
    await assert.rejects(
      () => agent.tools[0].execute({ text: '你好' }, { agent }),
      /feishuWebhook/,
    )
  })

  it('sends through the tool once configured', async () => {
    const settingsPath = tempSettings({ feishuWebhook: hook })
    const { agent } = mount({ workspaceRoot: workspace, settingsPath }, workspace)
    let body
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body)
      return { ok: true, json: async () => ({ code: 0 }) }
    }
    const result = await agent.tools[0].execute({ text: '长任务跑完了' }, { agent })
    assert.equal(result.note, '已发送')
    assert.deepEqual(body, { msg_type: 'text', content: { text: '长任务跑完了' } })
  })

  it('rejects empty text', async () => {
    const { agent } = mount(
      { workspaceRoot: workspace, settingsPath: tempSettings({ feishuWebhook: hook }) },
      workspace,
    )
    await assert.rejects(() => agent.tools[0].execute({ text: '   ' }, { agent }), /text 不能为空/)
  })
})
