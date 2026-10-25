import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { DEFAULT_ORDER, PERSONA_PREFIX_SECTION, apply, readPersona, resolveConfig } from '../src/persona/index.js'

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
  const handlers = []
  const sections = []
  const agent = {
    id: `session-${cwd}`,
    session: { header: { cwd, ...origin === undefined ? {} : { origin } } },
    get hooks() { return handlers.length + sections.length },
    /** 收到的系统提示 section（人格走这条）。 */
    get sections() { return sections },
    // 人格进系统提示的 section 槽（deployment:persona-prefix）；
    // 立场回声仍走 llm/stream，往请求末尾追加一条消息。
    ctx: {
      systemPrompt: {
        section(section) {
          sections.push(section)
          return () => {}
        },
      },
      on(event, handler) {
        if (event === 'llm/stream') handlers.push(handler)
        return () => {}
      },
    },
    /** 跑一遍组装，返回系统提示文本和末尾追加的内容。 */
    run() {
      const options = {
        sessionId: agent.id,
        messages: [{ role: 'system', content: [{ type: 'text', text: 'HARNESS' }] }],
      }
      for (const handler of handlers) handler(options, () => options)
      const persona = sections
        .map(section => (typeof section.text === 'function' ? section.text() : section.text))
        .filter(text => text !== '')
        .join('\n\n')
      const system = [persona, 'HARNESS'].filter(text => text !== '').join('\n\n')
      const tail = options.messages
        .slice(1)
        .map(message => message.content.map(part => part.text).join('\n'))
        .join('\n\n')
      return { system, tail, sections }
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
  it('takes over the deployment persona slot', () => {
    const { agent } = mount(
      { workspaceRoot: workspace, personaPath: tempPersona('我是谁'), echo: false },
      workspace,
    )
    const { system, tail, sections } = agent.run()
    assert.equal(sections.length, 1, '人格只占一个 section')
    assert.equal(sections[0].name, PERSONA_PREFIX_SECTION)
    assert.equal(sections[0].order, DEFAULT_ORDER)
    assert.equal(system, '我是谁\n\nHARNESS', '人格在最前面，宿主原本的内容跟在后面')
    assert.equal(tail, '', 'echo 关掉时不该在末尾追加')
  })

  it('gives nothing to sessions outside the workspace or to subagents', () => {
    const outside = mount({ workspaceRoot: workspace, personaPath: tempPersona('我是谁') }, 'C:/elsewhere')
    assert.equal(outside.agent.hooks, 0)

    const sub = mount({ workspaceRoot: workspace, personaPath: tempPersona('我是谁') }, workspace, 'subagent')
    assert.equal(sub.agent.hooks, 0, '子代理是工具，不是另一个人格')
  })

  // 系统提示的注意力会随上下文变长衰减：头尾两处各说一次是必要的冗余。
  it('echoes the same text at the very end of the request', () => {
    const { agent } = mount(
      { workspaceRoot: workspace, personaPath: tempPersona('我是谁'), echo: true },
      workspace,
    )
    const { system, tail } = agent.run()
    assert.equal(system, '我是谁\n\nHARNESS')
    assert.match(tail, /^## 立场/)
    assert.match(tail, /我是谁/)
  })

  it('can turn the echo off without losing the head copy', () => {
    const { agent } = mount(
      { workspaceRoot: workspace, personaPath: tempPersona('我是谁'), echo: false },
      workspace,
    )
    const { system, tail } = agent.run()
    assert.equal(system, '我是谁\n\nHARNESS')
    assert.equal(tail, '')
  })

  it('injects nothing when there is no persona file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'persona-')), 'persona.md')
    const { agent } = mount({ workspaceRoot: workspace, personaPath: path, echo: true }, workspace)
    const { system, tail } = agent.run()
    assert.equal(system, 'HARNESS', '没有就是没有，不拿默认人设填坑')
    assert.equal(tail, '')
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
