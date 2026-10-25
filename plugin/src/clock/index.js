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

import { resolveStatePath, resolveWorkspaceRoot } from '../paths.js'
import { inWorkspace } from '../workspace-gate.js'
import {
  DEFAULT_INTERVAL_MINUTES,
  idleText,
  pickTarget,
  renderTick,
  shouldWake,
} from './decide.js'
import { HeartbeatStore } from './heartbeat-store.js'

/** Cordis 插件名。 */
export const name = 'sinecause-clock'

const DEFAULT_PROMPT_UNSET = undefined

/** 校验配置。 */
function resolveConfig(config) {
  const intervalMinutes = config?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES
  if (typeof intervalMinutes !== 'number' || !(intervalMinutes > 0) || !Number.isFinite(intervalMinutes)) {
    throw new TypeError('sinecause-clock: intervalMinutes 必须是正数')
  }
  const workspaceRoot = resolveWorkspaceRoot(config?.workspaceRoot)
  const statePath = resolveStatePath(config?.statePath, workspaceRoot, 'heartbeat.json')
  const prompt = config?.prompt
  if (prompt !== undefined && typeof prompt !== 'string') {
    throw new TypeError('sinecause-clock: prompt 必须是字符串')
  }
  return {
    intervalMinutes,
    intervalMs: intervalMinutes * 60_000,
    workspaceRoot,
    statePath,
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
    // 会话自己设的门槛优先：这是 heartbeat 的全部意义。
    .map(entry => ({ ...entry, minIdleMs: options.minIdleMsOf?.(entry.id) }))
  const target = pickTarget(candidates, { now, minIdleMs: intervalMs })
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
  // 醒过一次，自定义门槛就完成使命了，回到默认节拍。
  options.clearOverride?.(target)
  return target
}

const HEARTBEAT_DESCRIPTION = [
  '设置下一次心跳的时机——不是定时任务，而是"安静多久之后再来叫我"。',
  '默认节拍是每 10 分钟一次。当你判断手上的事两小时内没戏、又不想被每十分钟叫一次时，',
  '用它把门槛调大：之后任何动静（你说话、我回话、工具调用）都会重新计时。',
  '醒过一次就自动回到默认节拍。idleMinutes 设 0 可以立刻恢复默认。',
].join('')

const HEARTBEAT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    idleMinutes: {
      type: 'number',
      description: '安静多少分钟之后再叫醒我；0 表示恢复默认节拍。上限 1440（一天）。',
    },
    reason: {
      type: 'string',
      description: '为什么慢下来，一句话。',
    },
  },
  required: ['idleMinutes'],
}

const HEARTBEAT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: { note: { type: 'string', description: '确认信息。' } },
  required: ['note'],
}

/**
 * 给一个会话注册 `heartbeat` 工具。
 *
 * 注册在 `agent.ctx` 上，所以只对这一个会话可见；工作区判定再做一次，
 * 因为会话中途换目录是可能的。
 */
function registerHeartbeatTool(agent, resolved, beats, currentCwd) {
  const ctx = agent.ctx
  ctx.tools.register({
    name: 'heartbeat',
    description: HEARTBEAT_DESCRIPTION,
    parameters: HEARTBEAT_PARAMETERS,
    output: {
      schema: HEARTBEAT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    execute(args, exec) {
      const cwd = currentCwd() ?? exec?.agent?.session?.header?.cwd
      if (!inWorkspace(cwd, resolved.workspaceRoot)) {
        throw new Error(`heartbeat 只在这个工作区的会话里可用（当前目录 ${String(cwd ?? '未知')}）`)
      }
      const minutes = Number(args?.idleMinutes)
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
        throw new Error('idleMinutes 必须在 0 到 1440 之间')
      }
      const id = String(exec?.agent?.id ?? agent.id)
      if (minutes === 0) {
        beats.clear(id)
        return { note: `已恢复默认节拍：安静 ${resolved.intervalMinutes} 分钟叫一次。` }
      }
      beats.set(id, Math.round(minutes * 60_000))
      const why = String(args?.reason ?? '').trim()
      return {
        note: `知道了：安静 ${idleText(minutes * 60_000)} 之后再来叫你。`
          + '这期间任何动静都会重新计时；醒一次就回到默认节拍。'
          + (why === '' ? '' : `（原因：${why}）`),
      }
    },
  })
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const registry = createRegistry()
  registry.workspaceRoot = resolved.workspaceRoot
  const beats = new HeartbeatStore(resolved.statePath)

  ctx.on('agent/created', ({ agent }) => {
    // 子代理是她的工具，不是她本人：给子代理发心跳只会浪费一轮。
    if (agent.session?.header?.origin === 'subagent') return
    const cwd = sessionCwd(ctx, agent)
    if (!inWorkspace(cwd, resolved.workspaceRoot)) return
    registry.track(String(agent.id), agent, cwd)
    try {
      registerHeartbeatTool(agent, resolved, beats, () => sessionCwd(ctx, agent))
    } catch (error) {
      // 注册失败不该让时钟停摆：没有工具就只是回到固定节拍。
      ctx.logger?.warn?.(`sinecause-clock: heartbeat 工具注册失败：${String(error?.message ?? error)}`)
    }
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
        minIdleMsOf: id => beats.get(id)?.idleMs,
        clearOverride: id => beats.clear(id),
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
