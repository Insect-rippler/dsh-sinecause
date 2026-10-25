/**
 * 请求组装：人格放最前，记忆/立场/目标放最后。三者都只存在于这一次请求里。
 *
 * 为什么不用另外两条路：
 * - `systemPrompt.context()`：会被 materialize 成 durable user-role snapshot，真的写进会话历史；
 *   同一份内容每变一次多一份，旧的那份还会在历史里假装是"当前"。
 * - `system-prompt/assemble`：不落库，但只能拼在系统提示里；而且 `AssembledSection`
 *   没有 order 字段，追加只能排最后——人格永远到不了开头。
 *
 * `llm/stream` 是请求已经拼好、正要交给适配器的那一刻。改 `options` 只影响这一份请求。
 *
 * 组装顺序（从前往后）：
 *   persona（拼在第一条 system 消息的最前面）
 *   系统提示其余部分
 *   session 历史
 *   ┌ 记忆（常驻档案 + 本轮向量/词法命中）
 *   ├ 立场（persona 快照，最贴近本轮触发）
 *   本轮触发（他说话 / 心跳唤醒 / 定时任务）
 *   └ 目标（注意力引导）
 *
 * **注册在哪很重要**：Cordis 的事件按 ctx 过滤（`Context.filter`），DSH 里所有
 * `llm/stream` 消费者都注册在**插件级 ctx**。注册在 `agent.ctx` 上实测收不到事件——
 * 表现是"代码明明执行了，请求里什么都没变"。所以这里提供 `installTailChannel(ctx)`，
 * 由插件在自己的 apply 里调一次；会话级注册保留下来只是为了让单测能直接驱动。
 */

/** agent → 块列表。按对象存：同一个 sessionId 换了个新 Agent 时，旧块不会串过来。 */
const blocks = new WeakMap()
/** agent → 人格正文的读取函数。 */
const prefixes = new WeakMap()
/** sessionId → 当前活着的 agent，请求到来时用它找块。 */
const agentOf = new Map()
/** 已经处理过的请求，避免同一份 options 被两个监听器各注入一次。 */
const patched = new WeakSet()
/** 已经装过监听的上下文。 */
const installed = new WeakSet()

/** 块放在哪。 */
export const PLACEMENT = {
  /** 插在本轮触发之前（记忆、立场）。 */
  beforeUser: 'before-user',
  /** 追加到最后（目标）。 */
  end: 'end',
}

/** 同一次请求里的先后：记忆在外、立场在内（立场最贴近本轮触发）。 */
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

/** 就地把人格拼到第一条 system 消息的最前面。 */
function applyPrefix(options, render) {
  const messages = options?.messages
  const first = messages?.[0]
  if (!Array.isArray(messages) || first?.role !== 'system' || !Array.isArray(first.content)) return false
  const [head, ...rest] = first.content
  if (head?.type !== 'text') return false
  const text = render()
  if (text === '') return false
  options.messages = [
    { ...first, content: [{ ...head, text: `${text}\n\n${head.text}` }, ...rest] },
    ...messages.slice(1),
  ]
  return true
}

/** 就地把记忆/立场插到本轮触发之前、目标追加到最后。 */
function applyBlocks(options, list) {
  const before = renderAll(list.filter(entry => entry.placement === PLACEMENT.beforeUser))
  const after = renderAll(list.filter(entry => entry.placement !== PLACEMENT.beforeUser))
  if (before === '' && after === '') return false

  const messages = [...(options.messages ?? [])]
  const last = messages[messages.length - 1]
  // "本轮触发"的判据是角色为 user：他说话、心跳唤醒、定时任务都是这一种，
  // 只是 source.kind 不同。工具结果那一步则都追加到末尾，顺序仍是 记忆 → 目标。
  if (before !== '' && last?.role === 'user') {
    messages.splice(messages.length - 1, 0, { role: 'user', content: [{ type: 'text', text: before }] })
  } else if (before !== '') {
    messages.push({ role: 'user', content: [{ type: 'text', text: before }] })
  }
  if (after !== '') messages.push({ role: 'user', content: [{ type: 'text', text: after }] })
  options.messages = messages
  return true
}

/** 上一次请求处理的自检信息：钩子到底跑没跑、拿到的 sessionId 认不认得。 */
const lastPatch = { at: null, sessionId: null, known: false, applied: false }

/** 自检：给 promptdump 用，回答"代码到底跑到哪一步"。 */
export function tailDiagnostics() {
  return {
    // 注册过块的会话 id（说明 agent/created 那侧是通的）
    registered: [...agentOf.keys()],
    lastPatch: { ...lastPatch },
  }
}

/** 处理一次请求；同一个 options 只处理一次。 */
function patch(options) {
  try {
    const sessionId = String(options?.sessionId ?? '')
    const agent = agentOf.get(sessionId)
    lastPatch.at = new Date().toISOString()
    lastPatch.sessionId = sessionId
    lastPatch.known = agent !== undefined
    if (agent === undefined) return
    const list = blocks.get(agent)
    const prefix = prefixes.get(agent)
    if (list === undefined && prefix === undefined) return
    if (patched.has(options)) return
    patched.add(options)
    let applied = false
    if (prefix !== undefined) applied = applyPrefix(options, prefix) || applied
    if (list !== undefined) applied = applyBlocks(options, list) || applied
    lastPatch.applied = applied
  } catch {
    // 拼装失败也不该让请求发不出去。
  }
}

/** 会话级监听：单测驱动用；生产里由 installTailChannel 负责。 */
function installAgentListener(agent) {
  if (installed.has(agent.ctx)) return
  installed.add(agent.ctx)
  try {
    agent.ctx.on('llm/stream', (options, next) => {
      patch(options)
      return next()
    })
  } catch {
    // ctx 不支持事件就只靠插件级通道。
  }
}

/**
 * 在插件级 ctx 上装一次通道。必须在插件的 `apply` 里调用——这是生产里唯一真正
 * 会收到 `llm/stream` 的那条路。
 * @param {object} ctx - 插件上下文。
 */
export function installTailChannel(ctx) {
  if (installed.has(ctx)) return
  installed.add(ctx)
  ctx.on('llm/stream', (options, next) => {
    patch(options)
    return next()
  })
}

/**
 * 给一个会话挂一块"请求里"的内容。
 * @param {object} agent - DSH 的 Agent。
 * @param {{ name: string, order: number, placement?: string, text: () => string }} block
 * @returns {() => void} 注销这一块。
 */
export function registerTailBlock(agent, block) {
  agentOf.set(String(agent.id), agent)
  const list = blocks.get(agent) ?? []
  const entry = { placement: PLACEMENT.end, ...block }
  list.push(entry)
  blocks.set(agent, list)

  installAgentListener(agent)
  return () => {
    const current = blocks.get(agent) ?? []
    const index = current.indexOf(entry)
    if (index >= 0) current.splice(index, 1)
  }
}

/**
 * 给一个会话挂"人格正文"（拼在请求里第一条 system 消息的最前面）。
 * @param {object} agent
 * @param {() => string} render
 */
export function registerRequestPrefix(agent, render) {
  agentOf.set(String(agent.id), agent)
  prefixes.set(agent, render)
  installAgentListener(agent)
}
