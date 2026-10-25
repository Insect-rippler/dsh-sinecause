/**
 * 把一块内容拼成"请求时组装"的段落，而不是落进 session 的快照。
 *
 * 区别在这里：
 * - `systemPrompt.context()` 会被 DSH materialize 成 **durable user-role snapshot**，
 *   也就是真的写进会话历史。它是"同一份内容每变一次就多一份"的，越聊越长，
 *   而且旧快照会一直躺在历史里假装是"当前"。
 * - `system-prompt/assemble` 是每次构建请求时的瀑布钩子：往里加的 section 只存在于
 *   这一次请求里，不落库，每轮重新算。
 *
 * 所以人格、记忆、目标这类"每次都要新鲜"的东西走这里；persona 本体则用 section()
 * 注册在系统提示最前面（那是注册式的，本来就不落库）。
 */

/**
 * 给一个会话挂一块请求时内容。
 *
 * @param {object} agent - DSH 的 Agent（用到它的 id 和 ctx）。
 * @param {{ name: string, order: number, text: () => string }} block
 *   `text` 在每次组装时调用，返回空串就表示这一轮不贡献内容。
 * @returns {() => void} 注销函数。
 */
export function registerTailBlock(agent, block) {
  const ctx = agent.ctx
  const id = String(agent.id)
  const append = assembled => {
    // 只影响自己这一份组装：别的会话不用看见这个工作区的东西。
    if (assembled === undefined || assembled === null) return assembled
    const text = block.text()
    if (text === '') return assembled
    assembled.sections.push({ name: block.name, order: block.order, text })
    return assembled
  }
  return ctx.on('system-prompt/assemble', (assembly, context, next) => {
    const owner = context?.agent
    if (owner === undefined || String(owner.id) !== id) return next()
    const after = next()
    // 真实宿主返回 Promise；测试里 next() 是同步的，两种都走得通。
    return after !== null && typeof after?.then === 'function' ? after.then(append) : append(after)
  })
}

/** 这些块排在系统提示的最后，紧贴对话——离"此刻"最近的位置。 */
export const TAIL_ORDERS = {
  stance: 5000,
  memory: 5010,
  goal: 5020,
}
