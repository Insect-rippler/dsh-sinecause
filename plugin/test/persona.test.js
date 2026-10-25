import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { DEFAULT_ORDER, apply, readPersona, resolveConfig } from '../src/persona/index.js'

const workspace = 'C:/work/sinecause'

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
  const sections = []
  const contexts = []
  const agent = {
    id: `session-${cwd}`,
    session: { header: { cwd, ...origin === undefined ? {} : { origin } } },
    sections,
    contexts,
    // 真实插件必须走 agent.ctx.inject(services, scope => ...) 才能注册系统提示；
    // 直接写 agent.ctx.systemPrompt.section(...) 会静默失效（踩过）。
    ctx: {
      inject(services, factory) {
        assert.ok(services.includes('systemPrompt'), '注册人格需要 systemPrompt 服务')
        factory({
          systemPrompt: {
            section(spec) {
              sections.push(spec)
              return () => {}
            },
          },
        })
        return { dispose: async () => {} }
      },
      // 尾部回声走"请求时组装"：同步模拟瀑布，产出包成旧断言的形状。
      on(event, handler) {
        if (event !== 'system-prompt/assemble') return () => {}
        const run = () => {
          const assembly = { sections: [], contexts: [], tools: [], variables: {} }
          handler(assembly, { agent }, () => assembly)
          return assembly.sections[0]
        }
        contexts.push({
          get name() { return run()?.name ?? '' },
          get order() { return run()?.order ?? 0 },
          interpolate: false,
          text: () => run()?.text ?? '',
        })
        return () => {}
      },
    },
  }
  return agent
}

function mount(config, cwd, origin) {
  const ctx = fakeCtx()
  apply(ctx, config)
  const agent = fakeAgent(cwd, origin)
  ctx.listeners.get('agent/created')({ agent })
  return { ctx, agent }
}

function tempPersona(text) {
  const path = join(mkdtempSync(join(tmpdir(), 'persona-')), 'persona.md')
  if (text !== undefined) writeFileSync(path, text, 'utf8')
  return path
}

describe('readPersona', () => {
  it('returns empty text when the file is missing', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'persona-')), 'persona.md')
    assert.equal(readPersona(path, 1200, undefined).text, '')
  })

  it('trims the file and ignores an empty one', () => {
    assert.equal(readPersona(tempPersona('  \n 我是谁 \n '), 1200).text, '我是谁')
    assert.equal(readPersona(tempPersona('   \n'), 1200).text, '')
  })

  it('caches by mtime and picks up an edit', async () => {
    const path = tempPersona('第一版')
    const first = readPersona(path, 1200, undefined)
    const second = readPersona(path, 1200, first.cache)
    assert.equal(second.text, '第一版')
    assert.equal(second.cache, first.cache, '没改就不该重读')

    // mtime 精度是秒级，等一下再写，否则两次修改可能被当成同一个版本。
    await new Promise(resolve => setTimeout(resolve, 20))
    writeFileSync(path, '第二版', 'utf8')
    const third = readPersona(path, 1200, second.cache)
    assert.equal(third.text, '第二版')
  })

  it('truncates text that would crowd out the tool instructions', () => {
    const text = '甲'.repeat(50)
    const result = readPersona(tempPersona(text), 10)
    assert.equal(result.text, `${'甲'.repeat(10)}…`)
  })
})

describe('plugin wiring', () => {
  it('registers one persona section at the front of the system prompt', () => {
    const { agent } = mount({ workspaceRoot: workspace, personaPath: tempPersona('我是谁') }, workspace)
    assert.equal(agent.sections.length, 1)
    const [section] = agent.sections
    assert.equal(section.name, 'sinecause:persona')
    assert.equal(section.order, DEFAULT_ORDER)
    assert.ok(section.order > -1000, '宿主身份仍然在最前')
    assert.ok(section.order < 500, '但必须早于一切策略')
    assert.equal(section.interpolate, false, '人格正文是用户数据，不能当模板插值')
    assert.equal(section.text(), '我是谁')
  })

  it('gives nothing to sessions outside the workspace or to subagents', () => {
    const outside = mount({ workspaceRoot: workspace, personaPath: tempPersona('我是谁') }, 'C:/elsewhere')
    assert.deepEqual(outside.agent.sections, [])
    assert.deepEqual(outside.agent.contexts, [])

    const sub = mount({ workspaceRoot: workspace, personaPath: tempPersona('我是谁') }, workspace, 'subagent')
    assert.deepEqual(sub.agent.sections, [], '子代理是工具，不是另一个人格')
    assert.deepEqual(sub.agent.contexts, [])
  })

  // 系统提示的注意力会随上下文变长衰减：头尾两处各说一次是必要的冗余。
  it('echoes the same text as a request-time stance anchor', () => {
    const { agent } = mount({ workspaceRoot: workspace, personaPath: tempPersona('我是谁') }, workspace)
    assert.equal(agent.contexts.length, 1)
    const [echo] = agent.contexts
    assert.equal(echo.name, 'sinecause:persona-echo')
    assert.ok(echo.order > 1000, '排在所有内建段落和工具说明之后，紧贴对话')
    assert.match(echo.text(), /^## 立场/)
    assert.match(echo.text(), /我是谁/)
  })

  it('can turn the echo off without losing the head copy', () => {
    const { agent } = mount(
      { workspaceRoot: workspace, personaPath: tempPersona('我是谁'), echo: false },
      workspace,
    )
    assert.deepEqual(agent.contexts, [])
    assert.equal(agent.sections.length, 1)
  })

  it('echoes nothing when there is no persona file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'persona-')), 'persona.md')
    const { agent } = mount({ workspaceRoot: workspace, personaPath: path }, workspace)
    assert.equal(agent.contexts[0].text(), '')
  })

  it('injects nothing when there is no persona file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'persona-')), 'persona.md')
    const { agent } = mount({ workspaceRoot: workspace, personaPath: path }, workspace)
    assert.equal(agent.sections[0].text(), '', '没有就是没有，不拿默认人设填坑')
  })

  it('rejects invalid configuration at load', () => {
    assert.throws(() => apply(fakeCtx(), { workspaceRoot: workspace, maxChars: 0 }), /maxChars/)
    assert.throws(() => apply(fakeCtx(), { workspaceRoot: 'relative/path' }), /workspaceRoot/)
  })

  it('resolves the persona file under the workspace by default', () => {
    const resolved = resolveConfig({ workspaceRoot: workspace })
    assert.match(resolved.personaPath.replaceAll('\\', '/'), /sinecause\/state\/persona\.md$/)
  })
})
