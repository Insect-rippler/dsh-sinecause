/**
 * sinecause-notify — 单向通知：把值得说的一句推给他。
 *
 * 现在接飞书群机器人（自定义机器人 webhook）。它是最省事的一条：建个只有自己的群、
 * 加个机器人、拿到 webhook 地址就能推，不需要审核、不需要公网地址。
 *
 * webhook 地址本身就是凭据，所以**不进代码、不进仓库**。解析顺序：
 *   1. 插件配置里的 `webhookUrl`
 *   2. `state/notify.json` 里的 `feishuWebhook`（默认，不在版本库里）
 *   3. 环境变量 `SINECAUSE_FEISHU_WEBHOOK`
 *
 * 地址在调用时才读，所以改配置不需要重启。
 */

import { readFileSync } from 'node:fs'

import { resolveStatePath, resolveWorkspaceRoot } from '../paths.js'
import { inWorkspace } from '../workspace-gate.js'

/** Cordis 插件名。 */
export const name = 'sinecause-notify'

/** 依赖的服务。 */
export const inject = ['tools']

/** 单条消息的字符上限：飞书文本消息够用，超了会被拒。 */
export const MAX_CHARS = 4000

/** 网络超时：推不出去就报错，不要挂着。 */
const TIMEOUT_MS = 10_000

export function resolveConfig(config) {
  const workspaceRoot = resolveWorkspaceRoot(config?.workspaceRoot)
  const settingsPath = resolveStatePath(config?.settingsPath, workspaceRoot, 'notify.json')
  const webhookUrl = config?.webhookUrl
  if (webhookUrl !== undefined && typeof webhookUrl !== 'string') {
    throw new TypeError('sinecause-notify: webhookUrl 必须是字符串')
  }
  return { workspaceRoot, settingsPath, webhookUrl }
}

/**
 * 解析 webhook 地址：配置 → 文件 → 环境变量。
 * @param {{ webhookUrl?: string, settingsPath: string }} resolved
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function resolveWebhook(resolved, env = process.env) {
  if (typeof resolved.webhookUrl === 'string' && resolved.webhookUrl.trim() !== '') {
    return resolved.webhookUrl.trim()
  }
  try {
    const raw = JSON.parse(readFileSync(resolved.settingsPath, 'utf8'))
    const fromFile = raw?.feishuWebhook
    if (typeof fromFile === 'string' && fromFile.trim() !== '') return fromFile.trim()
  } catch {
    // 文件不存在或坏了：继续往下找。
  }
  const fromEnv = env?.SINECAUSE_FEISHU_WEBHOOK
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return undefined
}

/**
 * 推一条消息。
 * @param {{ webhookUrl: string, text: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<string>} 成功时的说明。
 */
export async function sendNotification({ webhookUrl, text, fetchImpl = fetch }) {
  const body = JSON.stringify({ msg_type: 'text', content: { text } })
  const response = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`通知发送失败：HTTP ${response.status}`)
  }
  // 飞书用 body 里的 code 表示业务结果，HTTP 200 不代表成功。
  let payload
  try {
    payload = await response.json()
  } catch {
    return '已发送（响应不是 JSON，按成功处理）'
  }
  const code = Number(payload?.code ?? payload?.StatusCode ?? 0)
  if (Number.isFinite(code) && code !== 0) {
    throw new Error(`通知发送失败：飞书返回 code=${code} ${String(payload?.msg ?? payload?.StatusMessage ?? '')}`.trim())
  }
  return '已发送'
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)

  ctx.on('agent/created', ({ agent }) => {
    if (agent.session?.header?.origin === 'subagent') return
    const cwd = sessionCwd(ctx, agent)
    if (!inWorkspace(cwd, resolved.workspaceRoot)) return

    try {
      agent.ctx.tools.register({
        name: 'notify',
        description: [
          '给他推一条消息（单向：他收到，你不等他回）。',
          '用得上的时候：心跳里发现了值得他知道的事、长任务告一段落、需要他决定但不必打断当下。',
          '别用它刷存在感——没有新东西就不要推。',
        ].join(''),
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', description: '要说的内容，尽量一屏内说完。' },
          },
          required: ['text'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { note: { type: 'string', description: '发送结果。' } },
            required: ['note'],
          },
          render: (_args, value) => [{ type: 'text', text: value.note }],
        },
        async execute(args) {
          const text = String(args?.text ?? '').trim()
          if (text === '') throw new Error('text 不能为空')
          if (text.length > MAX_CHARS) throw new Error(`text 超过 ${MAX_CHARS} 字`)

          const live = sessionCwd(ctx, agent)
          if (!inWorkspace(live, resolved.workspaceRoot)) {
            throw new Error(`notify 只在这个工作区的会话里可用（当前目录 ${String(live ?? '未知')}）`)
          }

          const webhookUrl = resolveWebhook(resolved)
          if (webhookUrl === undefined) {
            throw new Error(
              `还没配通知地址：在 ${resolved.settingsPath} 里写 {"feishuWebhook": "https://open.feishu.cn/open-apis/bot/v2/hook/..."}，`
              + '或设环境变量 SINECAUSE_FEISHU_WEBHOOK。',
            )
          }
          return { note: await sendNotification({ webhookUrl, text }) }
        },
      })
    } catch (error) {
      ctx.logger?.warn?.(`sinecause-notify: 注册失败：${String(error?.message ?? error)}`)
    }
  })
}

/** 会话当前的工作目录；优先用 workingDirectory 服务，退回创建时的 header。 */
function sessionCwd(ctx, agent) {
  try {
    const live = ctx.get?.('workingDirectory')?.get?.(agent.session)
    if (typeof live === 'string' && live !== '') return live
  } catch {
    // 服务缺席时退回创建时的 header。
  }
  return agent.session?.header?.cwd
}
