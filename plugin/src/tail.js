/**
 * 请求末尾的两段：一段插在"本轮 user 消息"之前，一段追加在最后。
 *
 * 组装顺序（从前往后）：
 *   persona（系统提示最前面）
 *   系统提示其余部分
 *   session 历史
 *   ┌ 记忆（常驻档案 + 本轮向量/词法命中）    ← 插在 user 消息之前：先想起记得什么
 *   ├ 立场（persona 快照）                  ← 记忆的最内层，最贴近这一轮的请求
 *   user_message
 *   └ 目标（注意力引导）                     ← 最后一条：此刻该做什么
 *
 * 三条路里为什么选这条：
 * - `systemPrompt.context()`：会被 materialize 成 durable snapshot，真的写进会话历史；
 *   同一份内容每变一次多一份，旧的那份还会在历史里假装是"当前"。
 * - `system-prompt/assemble`：不落库，但拼在系统提示末尾，和对话之间隔着整段历史。
 * - `llm/stream`：请求已经拼好、正要交给适配器的那一刻。在这里改 `options.messages`，
 *   只影响这一份请求，不进 session，也不影响下一步。
 */

/** 每个 Agent 挂了哪些块。 */
const blocks = new WeakMap()
/** 已经装过 llm/stream 监听的 Agent。 */
const installed = new WeakSet()

/** 块放在哪。 */
export const PLACEMENT = {
  /** 插在本轮 user 消息之前（记忆、立场）。 */
  beforeUser: 'before-user',
  /** 追加到最后（目标）。 */
  end: 'end',
}

/** 同一次请求里的先后：记忆在外、立场在内（立场最贴近 user 消息）。 */
export const TAIL_ORDERS = {
  memory: 5000,
  stance: 5010,
  goal: 5020,
}

/** 把一组块按 order 拼成一条消息的文字；全空返回空串。 */
function renderAll(list) {
  return [...list]
    .sort((left, right) => left.order - right.order)
    .map(block => block.text())
    .filter(text => text !== '')
    .join('\n\n')
}

/**
 * 给一个会话挂一块"请求里"的内容。
 * @param {object} agent - DSH 的 Agent（用到 id 和 ctx）。
 * @param {{ name: string, order: number, placement?: string, text: () => string }} block
 * @returns {() => void} 注销这一块。
 */
export function registerTailBlock(agent, block) {
  const list = blocks.get(agent) ?? []
  list.push({ placement: PLACEMENT.end, ...block })
  blocks.set(agent, list)

  if (!installed.has(agent)) {
    installed.add(agent)
    const id = String(agent.id)
    agent.ctx.on('llm/stream', (options, next) => {
      try {
        if (String(options?.sessionId) !== id) return next()
        const current = blocks.get(agent) ?? []
        const before = renderAll(current.filter(entry => entry.placement === PLACEMENT.beforeUser))
        const after = renderAll(current.filter(entry => entry.placement !== PLACEMENT.beforeUser))

        const messages = [...(options.messages ?? [])]
        const last = messages[messages.length - 1]
        // 只有"最后一条是 user 消息"时才有"插在它之前"这个位置；
        // 工具结果之类的步骤就都追加到最后，顺序仍然是 记忆 → 目标。
        if (before !== '' && last?.role === 'user') {
          messages.splice(messages.length - 1, 0, { role: 'user', content: [{ type: 'text', text: before }] })
        } else if (before !== '') {
          messages.push({ role: 'user', content: [{ type: 'text', text: before }] })
        }
        if (after !== '') messages.push({ role: 'user', content: [{ type: 'text', text: after }] })
        options.messages = messages
      } catch {
        // 拼装失败也不该让请求发不出去。
      }
      return next()
    })
  }

  return () => {
    const current = blocks.get(agent) ?? []
    const index = current.indexOf(block)
    if (index >= 0) current.splice(index, 1)
  }
}
