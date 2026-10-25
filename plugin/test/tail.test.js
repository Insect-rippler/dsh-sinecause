import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PLACEMENT, TAIL_ORDERS, registerTailBlock } from '../src/tail.js'

/** 一个只收 llm/stream 监听的假 Agent。 */
function fakeAgent(id = 'session-1') {
  const listeners = []
  return {
    id,
    ctx: {
      on(event, handler) {
        if (event === 'llm/stream') listeners.push(handler)
        return () => {}
      },
    },
    /** 跑一遍请求组装；next 同步返回同一个 options，模拟瀑布。 */
    run(messages) {
      const options = { sessionId: id, messages }
      for (const listener of listeners) listener(options, () => options)
      return options.messages
    },
  }
}

const textOf = message => message.content.map(part => part.text).join('\n')

describe('request tail', () => {
  // 组装顺序是架构的一部分，钉死它：
  //   ...历史 → [记忆 → 立场] → user_message → [目标]
  it('puts memory and stance before the user message, goal after it', () => {
    const agent = fakeAgent()
    registerTailBlock(agent, {
      name: 'memory',
      order: TAIL_ORDERS.memory,
      placement: PLACEMENT.beforeUser,
      text: () => '## 记忆\n向量命中：x',
    })
    registerTailBlock(agent, {
      name: 'stance',
      order: TAIL_ORDERS.stance,
      placement: PLACEMENT.beforeUser,
      text: () => '## 立场\n我是谁',
    })
    registerTailBlock(agent, {
      name: 'goal',
      order: TAIL_ORDERS.goal,
      text: () => '## 目标与计划\n当前没有目标',
    })

    const messages = agent.run([{ role: 'user', content: [{ type: 'text', text: '他的问题' }] }])

    assert.equal(messages.length, 3, '注入两条 + 原来的 user 一条')
    assert.match(textOf(messages[0]), /## 记忆/)
    assert.match(textOf(messages[0]), /## 立场/)
    assert.ok(
      textOf(messages[0]).indexOf('## 记忆') < textOf(messages[0]).indexOf('## 立场'),
      '记忆在外、立场在内：立场最贴近 user 消息',
    )
    assert.equal(textOf(messages[1]), '他的问题', '原来的 user 消息保持原位')
    assert.match(textOf(messages[2]), /## 目标与计划/)
  })

  it('keeps the original messages untouched when a block renders empty', () => {
    const agent = fakeAgent()
    registerTailBlock(agent, {
      name: 'memory',
      order: TAIL_ORDERS.memory,
      placement: PLACEMENT.beforeUser,
      text: () => '',
    })
    const messages = agent.run([{ role: 'user', content: [{ type: 'text', text: '你好' }] }])
    assert.deepEqual(messages, [{ role: 'user', content: [{ type: 'text', text: '你好' }] }])
  })

  it('appends at the end when the last message is not from the user', () => {
    const agent = fakeAgent()
    registerTailBlock(agent, {
      name: 'memory',
      order: TAIL_ORDERS.memory,
      placement: PLACEMENT.beforeUser,
      text: () => '## 记忆\nx',
    })
    const messages = agent.run([{ role: 'tool', content: [{ type: 'text', text: '工具结果' }] }])
    assert.equal(messages.length, 2)
    assert.equal(textOf(messages[0]), '工具结果')
    assert.match(textOf(messages[1]), /## 记忆/)
  })

  it('only touches its own session', () => {
    const listeners = []
    const agent = {
      id: 'session-1',
      ctx: { on: (_event, handler) => { listeners.push(handler); return () => {} } },
    }
    registerTailBlock(agent, { name: 'goal', order: TAIL_ORDERS.goal, text: () => '## 目标' })

    const options = { sessionId: 'session-2', messages: [] }
    for (const handler of listeners) handler(options, () => options)
    assert.deepEqual(options.messages, [], '别的会话的请求不该被追加')
  })
})
