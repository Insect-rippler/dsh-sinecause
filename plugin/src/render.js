/**
 * 目标与计划的尾部渲染，移植自 SineCause 的 Monroe/core/turn.py::_agendaBlock。
 *
 * 输出贴到请求最末尾，用 `[ ] [>] [x] [!]` 四个符号把"现在该做哪一步"钉住。
 * 与参考实现一致：最多显示 5 个进行中的目标，只展开焦点目标的窗口步骤。
 */

/** 步骤状态到符号。未知状态落到待办。 */
const MARKS = { done: '[x]', doing: '[>]', blocked: '[!]' }

/** 关卡原因里最多显示几条"缺"。 */
const MISSING_LIMIT = 6

/** 把 `YYYY-MM-DD HH:MM:SS` 解析成本地毫秒；解析不了返回 null。 */
function parseStamp(text) {
  const value = String(text ?? '').trim()
  if (value.length < 16) return null
  const [date, time] = value.slice(0, 19).split(' ')
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi, s = 0] = time.split(':').map(Number)
  const stamp = new Date(y, mo - 1, d, h, mi, s).getTime()
  return Number.isFinite(stamp) ? stamp : null
}

/**
 * `10-23 18:02（2 小时前）`：建目标的时间要能和"现在"比。
 * @param {string} createdAt
 * @param {number} now
 */
export function ageText(createdAt, now) {
  const value = String(createdAt ?? '').trim()
  if (value.length < 16) return ''
  const when = parseStamp(value)
  if (when === null) return value.slice(0, 16)
  const age = Math.max(0, Math.floor((now - when) / 1000))
  const span = age < 3600
    ? `${Math.floor(age / 60)} 分钟前`
    : age < 86400
      ? `${Math.floor(age / 3600)} 小时前`
      : `${Math.floor(age / 86400)} 天前`
  return `${value.slice(5, 16)}（${span}）`
}

/** 一个目标的可读计数：`共 3 步（完成 0 · 可推进 3 · 卡住 1）`。 */
function countsText(steps) {
  const done = steps.filter(step => step.status === 'done').length
  const blocked = steps.filter(step => step.status === 'blocked').length
  const movable = steps.filter(step => step.status === 'doing' || step.status === 'pending').length
  const tail = blocked > 0
    ? `共 ${steps.length} 步（完成 ${done} · 可推进 ${movable} · 卡住 ${blocked}）`
    : `共 ${steps.length} 步（完成 ${done} · 可推进 ${movable}）`
  return tail
}

/** 一个步骤的附注：证据、卡点、截止时间。 */
function stepExtra(step) {
  let extra = ''
  if (step.status === 'done' && step.evidence) extra += `（证据：${step.evidence}）`
  if (step.status === 'blocked') {
    const bits = []
    if (Array.isArray(step.missing) && step.missing.length > 0) {
      bits.push(`缺：${step.missing.slice(0, MISSING_LIMIT).join('、')}`)
    }
    if (step.note) bits.push(`原因：${step.note}`)
    if (bits.length > 0) extra += `（${bits.join('；')}）`
  }
  if (step.dueAt) extra += `（截止 ${step.dueAt}）`
  return extra
}

/** 卡住的步骤单独成段：没有可推进的步骤时，替换掉窗口展示。 */
function blockedSection(lines, steps) {
  const blocked = steps.filter(step => step.status === 'blocked')
  if (blocked.length > 0) {
    lines.push('  没有能推进的步骤，卡住的是：')
    for (const step of blocked) {
      lines.push(`  [!] ${step.id}. ${step.title}${stepExtra(step)}`)
    }
    return true
  }
  return false
}

/**
 * 把 agenda 文档渲染成尾部文本。
 * @param {{ goals?: unknown[], timers?: unknown[] }} data - agenda 文档。
 * @param {{ now?: number, maxGoals?: number }} [options] - 注入时刻与目标上限。
 * @returns {string} 贴到请求末尾的文本；没有任何进行中的目标时也会返回一行提示。
 */
export function renderAgendaBlock(data, options = {}) {
  const now = options.now ?? Date.now()
  const maxGoals = options.maxGoals ?? 5
  const goals = (Array.isArray(data?.goals) ? data.goals : [])
    .filter(goal => goal !== null && typeof goal === 'object' && goal.status === 'active')
    .slice(0, maxGoals)
  const lines = ['## 目标与计划']
  const timers = Array.isArray(data?.timers) ? data.timers : []

  if (goals.length === 0) {
    lines.push('当前没有目标，需要寻找新的目标。')
    if (timers.length > 0) lines.push(timersLine(timers))
    return lines.join('\n')
  }

  // 焦点 = 第一个还有 doing/pending 步骤的目标；全部卡住时落在第一个。
  let focus = 1
  for (const [index, goal] of goals.entries()) {
    const steps = Array.isArray(goal.steps) ? goal.steps : []
    if (steps.some(step => step.status === 'doing' || step.status === 'pending')) {
      focus = index + 1
      break
    }
  }
  lines.push('符号：[ ] 待办　[>] 进行中　[x] 完成　[!] 卡住')
  if (goals.length > 1) {
    lines.push(`当前焦点：#${focus}（共 ${goals.length} 个 plan）。`
      + '同一时间只推进一个 plan；卡住的 plan 允许单独收尾，不算分心。')
  }

  for (const [index, goal] of goals.entries()) {
    const steps = Array.isArray(goal.steps) ? goal.steps : []
    const stamp = ageText(goal.createdAt, now)
    lines.push(`### ${index + 1}. ${goal.objective}（${goal.id}）· ${countsText(steps)}`
      + (stamp ? ` · 建于 ${stamp}` : ''))

    let at = steps.findIndex(step => step.status === 'doing')
    if (at < 0) at = steps.findIndex(step => step.status === 'pending')
    if (at < 0) {
      if (blockedSection(lines, steps)) {
        lines.push('  卡点不在你手上时：等外部条件解决（或用 wait 订个时间），'
          + `或者直接 plan finish/abandon（plan_id=${goal.id}），并在 note 里写清缺什么。`)
      } else if (steps.length > 0) {
        lines.push(`  步骤全部完成：用 plan finish 收尾（plan_id=${goal.id}）。`)
      } else {
        lines.push(`  还没有步骤：用 plan add 补步骤（plan_id=${goal.id}）。`)
      }
      continue
    }

    // 步骤多时只展开当前步附近的三步，避免尾部占太多。
    const showWindow = steps.length > 6
    const lo = showWindow ? Math.max(0, at - 1) : 0
    const hi = showWindow ? Math.min(steps.length, at + 2) : steps.length
    if (showWindow) lines.push(`  显示第 ${lo + 1}–${hi} 步（共 ${steps.length} 步）`)
    for (let position = lo; position < hi; position += 1) {
      const step = steps[position]
      const mark = MARKS[step.status] ?? '[ ]'
      let tag = ''
      if (position === at) tag = index === focus - 1 ? '（当前）' : '（先放着）'
      lines.push(`  ${mark} ${step.id}. ${step.title}${tag}${stepExtra(step)}`)
    }
  }

  if (timers.length > 0) lines.push(timersLine(timers))
  return lines.join('\n')
}

/** 定时器行；wait 系统将来消费同样的条目。 */
function timersLine(timers) {
  return '定时器：' + timers
    .map(timer => `${timer?.at ?? ''} ${timer?.reason ?? ''}`.trim())
    .filter(Boolean)
    .join('、')
}
