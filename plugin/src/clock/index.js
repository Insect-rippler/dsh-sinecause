/**
 * sinecause-clock — 时钟：没有你说话的时候，让她自己醒来。
 *
 * 只在这台机器上、应用开着的时候走。关掉应用等于失去意识；醒来不补算错过的
 * 时段，所以不会出现"关机一夜、回来补 100 次心跳"。
 *
 * 一跳做三件事：挑一个空闲够久的工作区会话、往它的收件箱塞一条心跳消息、
 * 把它的活跃时间推到当下。收件箱一有东西，loop 自然就起一轮。
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import { inWorkspace } from '../workspace-gate.js'
import {
  DEFAULT_INTERVAL_MINUTES,
  pickTarget,
  renderTick,
  shouldWake,
} from './decide.js'

/** Cordis 插件名。 */
export const name = 'sinecause-clock'

const DEFAULT_PROMPT_UNSET = undefined

/** 校验配置。 */
function resolveConfig(config) {
  const intervalMinutes = config?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES
  if (typeof intervalMinutes !== 'number' || !(intervalMinutes > 0) || !Number.isFinite(intervalMinutes)) {
    throw new TypeError('sinecause-clock: intervalMinutes 必须是正数')
  }
  const workspaceRoot = config?.workspaceRoot
  if (workspaceRoot !== undefined && (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot))) {
    throw new TypeError('sinecause-clock: workspaceRoot 必须是绝对路径')
  }
  const prompt = config?.prompt
  if (prompt !== undefined && typeof prompt !== 'string') {
    throw new TypeError('sinecause-clock: prompt 必须是字符串')
  }
  return {
    intervalMinutes,
    intervalMs: intervalMinutes * 60_000,
    workspaceRoot,
    prompt,
  }
}

/** 会话当前的工作目录。 */
function sessionCwd(ctx, agent) {
  try {
    const live = ctx.get?.('workingDirectory')?.get?.(agent.session)
    if (typeof live === 'string' && live !== '') return live
  } catch {
    // 服务缺席时退回创建时的 header。
  }
  return agent.session?.header?.cwd
}

/**
 * 一条心跳消息；带 form，好让记忆的召回查询把它当上下文而不是用户输入。
 * id 必须自带——收件箱靠 id 去重，缺了它第二条心跳会撞上"undefined 已在待处理"。
 */
export function heartbeatMessage(text, id = randomUUID()) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'sinecause-clock', form: 'notice', summary: 'clock tick' },
  }
}

/** 在内存里跟踪工作区会话的活跃度。 */
export function createRegistry() {
  const entries = new Map()
  return {
    track(id, agent, cwd) {
      entries.set(id, { agent, cwd, lastActivity: Date.now(), busy: false })
    },
    touch(id, now = Date.now()) {
      const entry = entries.get(id)
      if (entry !== undefined) entry.lastActivity = now
    },
    setBusy(id, busy) {
      const entry = entries.get(id)
      if (entry !== undefined) entry.busy = busy
    },
    drop(id) {
      entries.delete(id)
    },
    get(id) {
      return entries.get(id)
    },
    list() {
      return [...entries.entries()].map(([id, entry]) => ({
        id,
        lastActivity: entry.lastActivity,
        busy: entry.busy,
      }))
    },
  }
}

/**
 * 走一跳。被叫醒就返回那个 agent id，否则 undefined。
 * 抽出来是为了能不开 DSH 就测这段胶水。
 * @param {ReturnType<typeof createRegistry>} registry
 * @param {{ now: number, intervalMs: number, prompt?: string, send: (agent: object, text: string) => void, warn?: (message: string) => void, workspaceRoot?: string }} options
 */
export function runTick(registry, options) {
  const { now, intervalMs, prompt, send, warn, workspaceRoot } = options
  const candidates = registry.list()
    .filter(entry => inWorkspace(registry.get(entry.id).cwd, workspaceRoot))
  const target = pickTarget(candidates, { now, intervalMs })
  if (target === undefined) return undefined
  const entry = registry.get(target)
  const text = renderTick({ now, idleMs: now - entry.lastActivity, prompt })
  try {
    send(entry.agent, text)
  } catch (error) {
    // 叫不醒就等下一跳，不要让定时器崩掉。
    warn?.(`唤醒失败：${String(error?.message ?? error)}`)
  }
  registry.touch(target, now)
  return target
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const registry = createRegistry()
  registry.workspaceRoot = resolved.workspaceRoot

  ctx.on('agent/created', ({ agent }) => {
    // 子代理是她的工具，不是她本人：给子代理发心跳只会浪费一轮。
    if (agent.session?.header?.origin === 'subagent') return
    const cwd = sessionCwd(ctx, agent)
    if (!inWorkspace(cwd, resolved.workspaceRoot)) return
    registry.track(String(agent.id), agent, cwd)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    registry.drop(String(agent.id))
  })

  ctx.on('agent/status', ({ agent, status }) => {
    registry.setBusy(String(agent.id), status === 'running')
  })

  // 任何会话事件都算"有动静"，包括她自己被叫醒后的那一轮——
  // 所以心跳不会连发。
  ctx.on('session/event', session => {
    registry.touch(String(session.id))
  })

  const timer = setInterval(() => {
    try {
      runTick(registry, {
        now: Date.now(),
        intervalMs: resolved.intervalMs,
        prompt: resolved.prompt,
        workspaceRoot: resolved.workspaceRoot,
        send: (agent, text) => {
          // 必须走 followup：inbox.append 只入队，不叫醒驱动。
          agent.followup(heartbeatMessage(text))
        },
        warn: message => ctx.logger?.warn?.(`sinecause-clock: ${message}`),
      })
    } catch (error) {
      ctx.logger?.warn?.(`sinecause-clock: ${String(error?.message ?? error)}`)
    }
  }, resolved.intervalMs)

  // 定时器不该拦住进程退出。
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer))
}

/** 供测试复用的判定函数。 */
export { shouldWake }
