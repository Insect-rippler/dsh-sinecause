/**
 * 把一块内容挂在**请求的最末尾**——不是系统提示里，也不进 session 历史。
 *
 * 为什么不用另外两条路：
 * - `systemPrompt.context()`：DSH 会把它 materialize 成 durable user-role snapshot，
 *   真的写进会话。同一份内容每变一次多一份，旧的那份还会在历史里假装是"当前"。
 * - `system-prompt/assemble`：不落库，但它拼在**系统提示**末尾；系统提示和对话之间
 *   还隔着整段 session 历史，离"此刻"并不近。
 *
 * `llm/stream` 是请求已经拼好、正要交给适配器的那一刻：在这里往 `options.messages`
 * 末尾追加一条，模型看到的就是"历史之后、回答之前"的最后一段。它只存在于这次请求里，
 * 不进 session，也不影响下一步（每一步都会重新组装）。
 *
 * 三块内容按 order 合成**一条**消息，而不是各发一条：连着三条 user 消息对模型是噪声。
 */

/** 每个 Agent 挂了哪些块、是否已经装过监听。 */
const blocks = new WeakMap()
const installed = new WeakSet()

/** 这些块按 order 拼在最后，越小的越靠前。 */
export const TAIL_ORDERS = {
  stance: 5000,
  memory: 5010,
  goal: 5020,
}

/** 拼成一条消息里的文字；全空就返回空串（这一轮什么都不加）。 */
function renderAll(list) {
  return [...list]
    .sort((left, right) => left.order - right.order)
    .map(block => block.text())
    .filter(text => text !== '')
    .join('\n\n')
}

/**
 * 给一个会话挂一块"请求末尾"内容。
 * @param {object} agent - DSH 的 Agent（用到 id 和 ctx）。
 * @param {{ name: string, order: number, text: () => string }} block
 * @returns {() => void} 注销函数（移除这一块）。
 */
export function registerTailBlock(agent, block) {
  const list = blocks.get(agent) ?? []
  list.push(block)
  blocks.set(agent, list)

  if (!installed.has(agent)) {
    installed.add(agent)
    const id = String(agent.id)
    agent.ctx.on('llm/stream', (options, next) => {
      try {
        // 只动自己这个会话的请求。
        if (String(options?.sessionId) !== id) return next()
        const text = renderAll(blocks.get(agent) ?? [])
        if (text !== '') {
          options.messages = [
            ...(options.messages ?? []),
            { role: 'user', content: [{ type: 'text', text }] },
          ]
        }
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
