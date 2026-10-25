import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { apply, dumpRequest, renderRequest, resolveConfig } from '../src/promptdump/index.js'

const workspace = 'C:/work/sinecause'

function fakeCtx() {
  const listeners = new Map()
  return {
    on(event, listener) {
      listeners.set(event, listener)
      return () => {}
    },
    sessions: {
      get(id) {
        return id === 'inside' ? { header: { cwd: workspace } } : { header: { cwd: 'C:/elsewhere' } }
      },
    },
    logger: { warn() {} },
    listeners,
  }
}

function paths() {
  const dir = mkdtempSync(join(tmpdir(), 'dump-'))
  return { mdPath: join(dir, 'last-request.md'), jsonPath: join(dir, 'last-request.json') }
}

const sample = {
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  sessionId: 'inside',
  messages: [
    { role: 'system', content: [{ type: 'text', text: '你是……' }] },
    { role: 'user', content: [{ type: 'text', text: '## 立场\n我是谁' }] },
  ],
  tools: [{ name: 'plan' }, { name: 'notify' }],
}

describe('renderRequest', () => {
  it('shows the provider, model, tools and every message in order', () => {
    const md = renderRequest(sample, Date.UTC(2026, 9, 25, 4, 0, 0))
    assert.match(md, /deepseek-account/)
    assert.match(md, /deepseek-flash/)
    assert.match(md, /plan, notify/)
    assert.match(md, /### \[0\] system/)
    assert.match(md, /你是……/)
    assert.match(md, /### \[1\] user/)
    assert.match(md, /## 立场/)
  })

  it('keeps a one-shot system field but does not invent one', () => {
    const md = renderRequest({ ...sample, messages: [], system: '一次性调用的系统提示' })
    assert.match(md, /一次性调用的系统提示/)
    assert.equal(renderRequest({ messages: [] }).includes('## system 字段'), false)
  })
})

describe('dumpRequest', () => {
  it('writes both a readable and a raw copy', () => {
    const p = paths()
    dumpRequest(p, sample, 0)
    assert.ok(existsSync(p.mdPath))
    assert.ok(existsSync(p.jsonPath))
    const raw = JSON.parse(readFileSync(p.jsonPath, 'utf8'))
    assert.deepEqual(raw.tools, ['plan', 'notify'])
    assert.equal(raw.messages.length, 2)
  })
})

describe('plugin wiring', () => {
  it('stays quiet when disabled but still lets the request through', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'))
    const ctx = fakeCtx()
    ctx.sessions = { get: () => ({ header: { cwd: ws } }) }
    apply(ctx, { workspaceRoot: ws, enabled: false })
    const handler = ctx.listeners.get('llm/stream')
    let nexted = false
    handler(sample, () => {
      nexted = true
      return 'stream'
    })
    assert.equal(nexted, true)
    assert.equal(existsSync(join(ws, 'state', 'last-request.md')), false, '关着就不该落盘')
  })

  it('dumps workspace requests and still calls next', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'))
    const ctx = fakeCtx()
    ctx.sessions = { get: () => ({ header: { cwd: ws } }) }
    apply(ctx, { workspaceRoot: ws, enabled: true })
    const handler = ctx.listeners.get('llm/stream')

    let nexted = false
    const result = handler(sample, () => {
      nexted = true
      return 'stream'
    })
    assert.equal(nexted, true, '必须继续往下走，否则请求发不出去')
    assert.equal(result, 'stream')
    assert.match(readFileSync(join(ws, 'state', 'last-request.md'), 'utf8').slice(0, 20), /# 这次请求/)
  })

  it('ignores sessions outside the workspace', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'))
    const ctx = fakeCtx()
    apply(ctx, { workspaceRoot: ws, enabled: true })
    const handler = ctx.listeners.get('llm/stream')
    const before = existsSync(join(ws, 'state', 'last-request.md'))
      ? readFileSync(join(ws, 'state', 'last-request.md'), 'utf8')
      : undefined
    handler({ ...sample, sessionId: 'outside' }, () => 'stream')
    const after = existsSync(join(ws, 'state', 'last-request.md'))
      ? readFileSync(join(ws, 'state', 'last-request.md'), 'utf8')
      : undefined
    assert.equal(after, before, '别处会话的内容不该写进我们的 state')
  })

  it('resolves defaults and the env switch', () => {
    const resolved = resolveConfig({ workspaceRoot: workspace })
    assert.match(resolved.mdPath.replaceAll('\\', '/'), /sinecause\/state\/last-request\.md$/)
    assert.equal(resolved.enabled, false)
  })
})
