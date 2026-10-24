/**
 * 目标与计划的状态机，移植自 SineCause 的 Monroe/core/agenda.py。
 *
 * 数据落在单个 JSON 文件里，格式与参考实现一致：
 *   { goals: [...], timers: [...], lastInteraction: "YYYY-MM-DD HH:MM:SS" }
 *
 * 时间戳故意沿用本地时间字符串而不是 ISO：与参考实现可以互换数据，
 * 也让人直接读 state/agenda.json 时不用换算时区。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 同时推进的目标上限。 */
export const MAX_ACTIVE = 6

/** 本地时间戳，格式 `YYYY-MM-DD HH:MM:SS`。 */
export function stamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function newId(prefix = 'g') {
  // 与参考实现一致：毫秒时间戳的后 10 位，碰撞概率足够低且可读。
  return `${prefix}_${String(Date.now() % 10 ** 10)}`
}

/** 空文档。 */
export function empty() {
  return { goals: [], timers: [], lastInteraction: '' }
}

/** 把任意读到的 JSON 规范化成文档；不认识的结构降级为空。 */
export function normalize(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return empty()
  const goals = Array.isArray(raw.goals) ? raw.goals.filter(goal => goal !== null && typeof goal === 'object') : []
  const timers = Array.isArray(raw.timers) ? raw.timers.filter(timer => timer !== null && typeof timer === 'object') : []
  return {
    goals,
    timers,
    lastInteraction: typeof raw.lastInteraction === 'string' ? raw.lastInteraction : '',
  }
}

/** 把 `HH:MM`、`YYYY-MM-DD HH:MM(:SS)` 规范成本地时间戳；解析不了就原样返回。 */
export function normalizeAt(raw) {
  const text = String(raw ?? '').trim()
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (match !== null) {
    return stamp(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4]), Number(match[5]), Number(match[6] ?? 0)))
  }
  match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (match !== null) {
    const now = new Date()
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
      Number(match[1]), Number(match[2]), Number(match[3] ?? 0))
    // 只给时分时，落到"下一个该时刻"，避免刚写就过期。
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1)
    return stamp(candidate)
  }
  return text
}

/** 一次目标与计划的状态机实例：构造时读盘，写操作立即落盘。 */
export class Agenda {
  /** @param {string} path - agenda.json 的绝对路径。 */
  constructor(path) {
    /** @type {string} */
    this.path = path
    /** @type {ReturnType<typeof empty>} */
    this.data = empty()
    this.load()
  }

  /** 读盘；文件缺失或损坏时返回空文档，不抛错。 */
  load() {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      this.data = normalize(raw)
    } catch {
      this.data = empty()
    }
    return this.data
  }

  /** 原子写盘：先写 .tmp 再 rename，避免半截文件。 */
  save() {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.path)
  }

  /** 全部目标。 */
  goals() {
    return this.data.goals
  }

  /** 进行中的目标。 */
  activeGoals() {
    return this.data.goals.filter(goal => goal.status === 'active')
  }

  /**
   * 选一个进行中的目标：给了 id 就用 id，否则取第一个。
   * @param {string | undefined} goalId
   */
  pickGoal(goalId) {
    if (goalId !== undefined && goalId !== null && String(goalId).trim() !== '') {
      const found = this.data.goals.find(goal => String(goal.id) === String(goalId))
      if (found === undefined) throw new Error(`找不到 plan：${goalId}`)
      return found
    }
    const active = this.activeGoals()
    if (active.length === 0) throw new Error('当前没有进行中的目标')
    return active[0]
  }

  /** 新建目标，第一步自动进入 doing。 */
  createGoal(objective, steps = [], maxActive = MAX_ACTIVE) {
    const text = String(objective ?? '').trim()
    if (text === '') throw new Error('objective 不能为空')
    if (this.activeGoals().length >= maxActive) {
      throw new Error(`同时最多 ${maxActive} 个 plan，先收尾一个再开`)
    }
    const goal = {
      id: newId('g'),
      objective: text,
      status: 'active',
      createdAt: stamp(),
      note: '',
      steps: [],
    }
    for (const [index, raw] of steps.entries()) {
      const title = (raw !== null && typeof raw === 'object' ? raw.title : raw) ?? ''
      const trimmed = String(title).trim()
      if (trimmed === '') continue
      goal.steps.push({
        id: index + 1,
        title: trimmed,
        status: 'pending',
        evidence: '',
        dueAt: (raw !== null && typeof raw === 'object' ? raw.dueAt : null) ?? null,
      })
    }
    // 跳过的空标题会让 id 不连续，这里重排一次，保证 [id] 与序号一致。
    goal.steps.forEach((step, index) => { step.id = index + 1 })
    if (goal.steps.length > 0) goal.steps[0].status = 'doing'
    this.data.goals.push(goal)
    this.save()
    return goal
  }

  /** 收尾目标。 */
  finishGoal(note = '', goalId) {
    const goal = this.pickGoal(goalId)
    goal.status = 'done'
    goal.note = String(note ?? '')
    goal.finishedAt = stamp()
    this.save()
    return goal
  }

  /** 放弃目标。 */
  abandon(reason = '', goalId) {
    const goal = this.pickGoal(goalId)
    goal.status = 'abandoned'
    goal.note = String(reason ?? '')
    this.save()
    return goal
  }

  /** 某目标的步骤；目标不存在时返回空数组。 */
  steps(goalId) {
    try {
      return this.pickGoal(goalId).steps ?? []
    } catch {
      return []
    }
  }

  /** 当前可推进的步骤：doing 优先，其次第一个 pending。 */
  currentStep(goalId) {
    const steps = this.steps(goalId)
    return steps.find(step => step.status === 'doing')
      ?? steps.find(step => step.status === 'pending')
      ?? null
  }

  /** 显式 step_id 优先，否则取当前步骤。 */
  pickStep(stepId, goalId) {
    const steps = this.steps(goalId)
    if (steps.length === 0) throw new Error('当前没有计划')
    if (stepId !== undefined && stepId !== null) {
      const found = steps.find(step => Number(step.id) === Number(stepId))
      if (found === undefined) throw new Error(`找不到第 ${stepId} 步`)
      return found
    }
    const step = this.currentStep(goalId)
    if (step === null) throw new Error('没有可推进的步骤（都完成了？）')
    return step
  }

  /** 标记一步完成；下一步自动进入 doing。 */
  stepDone(stepId, evidence = '', goalId) {
    const step = this.pickStep(stepId, goalId)
    step.status = 'done'
    step.evidence = String(evidence ?? '')
    step.doneAt = stamp()
    const next = this.currentStep(goalId)
    if (next !== null) next.status = 'doing'
    this.save()
    return step
  }

  /** 标记一步卡住，并记下缺什么。 */
  stepBlock(stepId, missing = [], reason = '', goalId) {
    const step = this.pickStep(stepId, goalId)
    step.status = 'blocked'
    step.missing = (Array.isArray(missing) ? missing : [missing]).map(item => String(item ?? '')).filter(Boolean)
    step.blockedAt = stamp()
    step.note = String(reason ?? '')
    this.save()
    return step
  }

  /** 追加一步；目标原本没有步骤时这一步直接进入 doing。 */
  addStep(title, dueAt = null, goalId) {
    const text = String(title ?? '').trim()
    if (text === '') throw new Error('title 不能为空')
    const goal = this.pickGoal(goalId)
    goal.steps ??= []
    const step = {
      id: goal.steps.length + 1,
      title: text,
      status: goal.steps.length === 0 ? 'doing' : 'pending',
      evidence: '',
      dueAt: dueAt ?? null,
    }
    goal.steps.push(step)
    this.save()
    return step
  }

  /** 记一个定时器；由 wait 系统消费，目前只存。 */
  addTimer(at, reason = '') {
    const timer = { id: newId('t'), at: String(at ?? ''), reason: String(reason ?? ''), createdAt: stamp() }
    this.data.timers.push(timer)
    this.save()
    return timer
  }

  /** 记一次互动，供尾部提示与 wait 判断。 */
  touch() {
    this.data.lastInteraction = stamp()
    this.save()
  }
}
