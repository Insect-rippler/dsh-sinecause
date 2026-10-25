/**
 * sinecause-promptdump — 在真正发出去之前，把这次请求原样落一份。
 *
 * 挂的是 `llm/stream` 这个环绕钩子：`options` 就是适配器即将拿到的完整载荷
 * （messages / system / tools），所以落下来的东西和模型看到的是同一份，
 * 不是"我猜它长什么样"。
 *
 * 默认关闭。打开方式两选一：
 *   - 配置 `enabled: true`
 *   - 环境变量 `SINECAUSE_DUMP_PROMPT=1`
 *
 * 打开后每次请求写两个文件到 `<workspace>/state/`：
 *   last-request.md    给人看的：系统提示、注入块、工具清单、消息摘要
 *   last-request.json  给机器看的：原始载荷（工具 schema 太长，留个名字）
 *
 * 关掉时只多一次布尔判断——调试工具不该成为常驻开销。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { resolveWorkspaceRoot } from '../paths.js'
import { inWorkspace } from '../workspace-gate.js'

export const name = 'sinecause-promptdump'

/**
 * 必须声明这两个依赖：
 * - `llm` 提供 `llm/stream` 这个环绕钩子本身；
 * - `sessions` 用来从 sessionId 反查会话的 cwd（判断是不是这个工作区的）。
 * 少了它们，钩子里 `ctx.sessions` 是 undefined，取不到 cwd 就静默跳过——
 * 表现是"开关打开了但什么都没发生"。这条是踩出来的。
 */
export const inject = ['llm', 'sessions']

/** 单条消息正文在 .md 里的截断长度：系统提示本身就有几千字，截太短反而看不清。 */
const TEXT_LIMIT = 20000

/** 原始 JSON 的上限：超了就不写，避免把工程目录塞满。 */
const JSON_LIMIT = 4 * 1024 * 1024

export function resolveConfig(config) {
  const workspaceRoot = resolveWorkspaceRoot(config?.workspaceRoot)
  const enabled = config?.enabled ?? (process.env.SINECAUSE_DUMP_PROMPT === '1')
  if (typeof enabled !== 'boolean') {
    throw new TypeError('sinecause-promptdump: enabled 必须是布尔值')
  }
  return {
    workspaceRoot,
    enabled,
    // 开关文件：调试时建一个就能打开，删掉就关，**不用重启**。
    flagPath: join(workspaceRoot, 'state', 'dump-prompt.on'),
    mdPath: join(workspaceRoot, 'state', 'last-request.md'),
    jsonPath: join(workspaceRoot, 'state', 'last-request.json'),
    // 自检：每次被调用时写一份"走到哪一步、为什么停"。省得靠猜。
    statusPath: join(workspaceRoot, 'state', 'promptdump.status.json'),
  }
}

/** 把一条消息的内容折成文字：只取文本部分，图片等只留个标记。 */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    else if (part?.type !== undefined) parts.push(`[${String(part.type)}]`)
  }
  return parts.join('\n')
}

function clip(text, limit = TEXT_LIMIT) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（截断，共 ${text.length} 字）`
}

/**
 * 渲染成给人看的 markdown。
 * @param {any} options - GenerateOptions
 * @param {number} [now]
 */
export function renderRequest(options, now = Date.now()) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  const lines = [
    '# 这次请求发出去的样子',
    '',
    `- 时间：${new Date(now).toLocaleString('zh-CN')}`,
    `- provider：${String(options?.provider ?? '')}`,
    `- model：${String(options?.model ?? '')}`,
    `- 消息条数：${messages.length}`,
    `- 工具：${(options?.tools ?? []).map(tool => String(tool?.name ?? '')).filter(Boolean).join(', ') || '（无）'}`,
    '',
  ]

  if (typeof options?.system === 'string' && options.system !== '') {
    lines.push('## system 字段', '', '```text', clip(options.system), '```', '')
  }

  lines.push('## 消息', '')
  messages.forEach((message, index) => {
    const role = String(message?.role ?? '?')
    lines.push(`### [${index}] ${role}`, '')
    const body = textOf(message)
    lines.push(body === '' ? '（无文本内容）' : '```text\n' + clip(body) + '\n```', '')
  })

  return `${lines.join('\n')}\n`
}

/**
 * 写一份。写不进去就算了——调试工具不该影响请求。
 * @param {{ mdPath: string, jsonPath: string }} paths
 * @param {any} options
 * @param {number} now
 */
export function dumpRequest(paths, options, now = Date.now()) {
  try {
    mkdirSync(dirname(paths.mdPath), { recursive: true })
    writeFileSync(paths.mdPath, renderRequest(options, now), 'utf8')
  } catch {
    // 落盘失败不影响请求本身。
  }
  try {
    const raw = JSON.stringify(
      {
        at: new Date(now).toISOString(),
        provider: options?.provider,
        model: options?.model,
        system: options?.system,
        messages: options?.messages,
        // 工具 schema 太长，只留名字：调试上下文时不需要重新读一遍 JSON Schema。
        tools: (options?.tools ?? []).map(tool => tool?.name),
      },
      null,
      2,
    )
    if (raw.length <= JSON_LIMIT) writeFileSync(paths.jsonPath, `${raw}\n`, 'utf8')
  } catch {
    // 同上。
  }
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)

  // 钩子总是挂着，开关在每次请求时判：这样调试时建个文件就能开，
  // 不用为了看一次 payload 重启一次 DSH。关掉时只多一次 stat。
  const isOn = () => resolved.enabled || existsSync(resolved.flagPath)

  /** 写一行自检状态：卡在哪一步，一眼能看见。 */
  const report = (fields) => {
    try {
      writeFileSync(
        resolved.statusPath,
        `${JSON.stringify({ at: new Date().toISOString(), workspaceRoot: resolved.workspaceRoot, ...fields }, null, 2)}\n`,
        'utf8',
      )
    } catch {
      // 自检写不进去也不能影响请求。
    }
  }

  ctx.on('llm/stream', (options, next) => {
    try {
      const on = isOn()
      if (on) {
        const sessionId = options?.sessionId
        const sessions = ctx.sessions
        const session = sessionId === undefined || sessions === undefined ? undefined : sessions.get?.(sessionId)
        const cwd = session?.header?.cwd
        const matched = inWorkspace(cwd, resolved.workspaceRoot)
        // 只落这个工作区的：别把别处会话的内容写到我们的 state 里。
        if (matched) dumpRequest(resolved, options)
        report({
          on,
          hasSessions: sessions !== undefined,
          sessionId: sessionId === undefined ? null : String(sessionId),
          hasSession: session !== undefined,
          cwd: cwd === undefined ? null : String(cwd),
          matched,
          messages: Array.isArray(options?.messages) ? options.messages.length : 0,
        })
      }
    } catch (error) {
      report({ on: true, error: String(error?.message ?? error) })
    }
    return next()
  })
}
