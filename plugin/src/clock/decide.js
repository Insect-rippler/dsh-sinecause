/**
 * 时钟的判定逻辑：这一刻该不该叫醒她、叫醒时说些什么。
 *
 * 和 DSH 解耦，纯函数，便于单测。真正挂定时器的是 `index.js`。
 */

/** 默认心跳间隔（分钟）。快速迭代期用短间隔，稳定后调大。 */
export const DEFAULT_INTERVAL_MINUTES = 10

/** 默认心跳文案。`{{now}}` 与 `{{idle}}` 会被替换。 */
export const DEFAULT_PROMPT = [
  '[心跳] 现在是 {{now}}，距上次动静已经 {{idle}}。',
  '先看上下文末尾的「目标与计划」和「记忆」：',
  '- 有能推进的步骤就去推进，做完用 plan done 记下证据；',
  '- 攒够见闻就整理一次（memory curate）；',
  '- 两边都空，就自己找一件：学一个新工具或读点东西，学到的用 memory add 记成 skill 或 episode。',
  '没事可做就简短说一句你在做什么；不要为了说话而说话。',
].join('\n')

/** 本地 `HH:MM`。 */
export function clockText(now) {
  const date = new Date(now)
  const pad = value => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 把毫秒说成人话：`18 分钟` / `2 小时 5 分`。 */
export function idleText(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
}

/**
 * 该不该叫醒：空闲够久、且这一轮没在跑。
 *
 * `minIdleMs` 是这一跳的门槛：默认是配置的间隔，会话自己用 `heartbeat` 调过就以它为准
 * （—"这事两小时内没戏，别每十分钟叫我"）。
 * @param {{ now: number, lastActivity: number, minIdleMs: number, busy: boolean }} state
 * @returns {boolean}
 */
export function shouldWake({ now, lastActivity, minIdleMs, busy }) {
  if (busy) return false
  if (!Number.isFinite(lastActivity)) return false
  return now - lastActivity >= minIdleMs
}

/**
 * 渲染这一跳的文案。
 * @param {{ now: number, idleMs: number, prompt?: string }} input
 * @returns {string}
 */
export function renderTick({ now, idleMs, prompt }) {
  const template = prompt ?? DEFAULT_PROMPT
  return template
    .replaceAll('{{now}}', clockText(now))
    .replaceAll('{{idle}}', idleText(idleMs))
}

/**
 * 挑要叫醒的那个：空闲够久、没在跑的里面，取最近活跃的一个。
 * 她是一个人，不是一群——多个会话同时活着时，只叫最近说话的那个。
 * @param {{ id: string, lastActivity: number, busy: boolean, minIdleMs?: number }[]} agents
 * @param {{ now: number, minIdleMs: number }} options
 * @returns {string | undefined} 被选中的 agent id。
 */
export function pickTarget(agents, { now, minIdleMs }) {
  const ready = agents.filter(agent => shouldWake({
    now,
    lastActivity: agent.lastActivity,
    // 会话自己设了门槛就用它的——这是 heartbeat 的全部意义。
    minIdleMs: agent.minIdleMs ?? minIdleMs,
    busy: agent.busy,
  }))
  if (ready.length === 0) return undefined
  ready.sort((left, right) => right.lastActivity - left.lastActivity)
  return ready[0].id
}
