/**
 * dsh-sinecause — 目标与计划的尾部注入 + `plan` 工具。
 *
 * 两个挂点，都注册在该 Agent 自己的 scope 里（`agent.ctx`）：
 *   1. `system-prompt/assemble` —— 每次请求时把 agenda 拼进系统提示末尾，不落库。
 *      快照是请求的**最后一条** user message，内容不变就不重发，变了就替换旧快照。
 *      这是"引导注意力"的落点：不占开头，只贴着本轮任务。
 *   2. `tools.register()` —— 一个 action 形式的 `plan` 工具，读写同一个 agenda.json。
 *
 * 只对 cwd 落在 `workspaceRoot` 下的会话注册，所以装进共享 profile 也不会
 * 让本家的会话多出这个工具。
 *
 * 插件不带任何 @deepseek-ai 依赖，所以能以 `file:` 依赖装进 profile。
 */

import { Agenda, MAX_ACTIVE, normalizeAt } from './agenda.js'
import { resolveStatePath, resolveWorkspaceRoot } from './paths.js'
import { renderAgendaBlock } from './render.js'
import { TAIL_ORDERS, registerTailBlock } from './tail.js'
import { inWorkspace } from './workspace-gate.js'

export { inWorkspace } from './workspace-gate.js'

/** Cordis 插件名。 */
export const name = 'sinecause-goal'

/** 依赖的服务：工具注册与提示词装配。 */
export const inject = ['tools', 'systemPrompt']

/** `plan` 工具接受的 action。 */
export const ACTIONS = ['create', 'list', 'done', 'block', 'add', 'timer', 'finish', 'abandon']

/** 尾部快照在 runtime context 里的排序位；晚于所有内建 context（最高 210）。 */
const CONTEXT_ORDER = 300

const DESCRIPTION = '管理你自己的目标与计划（可并行多个 plan）。'
  + 'create 新建 plan；list 看全部；done/block/add 推进步骤；timer 设定时点；finish/abandon 收尾。'
  + '多个 plan 时用 plan_id 指名，步骤用 step_id。'
  + '计划会渲染在上下文的末尾，所以这里只记事实，不要在回复里复述整份计划。'

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description: '要做的操作。',
    },
    objective: {
      type: 'string',
      description: 'create：目标的完整描述，一句话说清做完是什么样。',
    },
    steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'create：按顺序排列的步骤标题；第一步会自动进入进行中。',
    },
    plan_id: {
      type: 'string',
      description: '目标 id（形如 g_2763909800）。有多个进行中的 plan 时必须给。',
    },
    step_id: {
      type: 'integer',
      description: '步骤序号。省略时取当前那一步。',
    },
    evidence: {
      type: 'string',
      description: 'done：实际看到的证据，一句话，不要写"已完成"。',
    },
    missing: {
      type: 'array',
      items: { type: 'string' },
      description: 'block：卡在哪几件事上，写成具体的缺项。',
    },
    reason: {
      type: 'string',
      description: 'block/abandon：为什么卡住或放弃。',
    },
    title: {
      type: 'string',
      description: 'add：新步骤的标题。',
    },
    dueAt: {
      type: 'string',
      description: 'add：这一步的截止时间，`YYYY-MM-DD HH:MM` 或 `HH:MM`。',
    },
    at: {
      type: 'string',
      description: 'timer：唤醒时间，`YYYY-MM-DD HH:MM` 或 `HH:MM`。',
    },
    note: {
      type: 'string',
      description: 'finish：收尾时记一句结论。',
    },
  },
  required: ['action'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agenda: { type: 'string', description: '执行后的目标与计划渲染结果。' },
  },
  required: ['agenda'],
}

/** 校验配置；路径缺省时按工作区默认解析，解析不了就在加载时失败。 */
function resolveConfig(config) {
  const workspaceRoot = resolveWorkspaceRoot(config?.workspaceRoot)
  const statePath = resolveStatePath(config?.statePath, workspaceRoot, 'agenda.json')
  const maxGoalsShown = config?.maxGoalsShown ?? 5
  if (!Number.isSafeInteger(maxGoalsShown) || maxGoalsShown < 1) {
    throw new TypeError('dsh-sinecause: maxGoalsShown 必须是正整数')
  }
  const maxActive = config?.maxActive ?? MAX_ACTIVE
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
    throw new TypeError('dsh-sinecause: maxActive 必须是正整数')
  }
  return { statePath, maxGoalsShown, maxActive, workspaceRoot }
}

/** 会话当前的工作目录；优先用 workingDirectory 服务，退回创建时的 header。 */
function sessionCwd(ctx, agent) {
  try {
    const live = ctx.get?.('workingDirectory')?.get?.(agent.session)
    if (typeof live === 'string' && live !== '') return live
  } catch {
    // 服务缺席或尚未就绪时退回 header。
  }
  return agent.session?.header?.cwd
}

/** 在 Agent 自己的 scope 里注册尾部 context 与 plan 工具；随 Agent 一起释放。 */
function registerForAgent(agent, resolved) {
  const ctx = agent.ctx
  const render = () => {
    try {
      return renderAgendaBlock(new Agenda(resolved.statePath).data, {
        maxGoals: resolved.maxGoalsShown,
        now: Date.now(),
      })
    } catch {
      // 状态文件坏了不该让整个请求失败：这一轮不注入。
      return ''
    }
  }

  // 请求时组装：不落进 session。DSH 的 context() 会 materialize 成 durable 快照，
  // 那等于把"当前目标"一遍遍写进历史，旧的那份还会假装是当前。
  registerTailBlock(agent, {
    name: 'sinecause:goal',
    order: TAIL_ORDERS.goal,
    text: () => {
      if (!inWorkspace(sessionCwd(ctx, agent), resolved.workspaceRoot)) return ''
      return render()
    },
  })

  ctx.tools.register({
    name: 'plan',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.agenda }],
    },
    async execute(args, exec) {
      // 注册已按 Agent 过滤，这里再挡一次：工作目录可能在会话中途换出去。
      const cwd = sessionCwd(ctx, exec?.agent ?? agent)
      if (!inWorkspace(cwd, resolved.workspaceRoot)) {
        throw new Error(`plan 只在这个工作区的会话里可用（当前目录 ${String(cwd ?? '未知')}）`)
      }
      const action = String(args.action ?? 'list').trim().toLowerCase()
      const book = new Agenda(resolved.statePath)
      switch (action) {
        case 'create':
          book.createGoal(args.objective, args.steps ?? [], resolved.maxActive)
          break
        case 'done':
          book.stepDone(args.step_id, args.evidence ?? '', args.plan_id)
          break
        case 'block':
          book.stepBlock(args.step_id, args.missing ?? [], args.reason ?? '', args.plan_id)
          break
        case 'add':
          book.addStep(args.title, args.dueAt ?? null, args.plan_id)
          break
        case 'timer':
          book.addTimer(normalizeAt(args.at), args.reason ?? '')
          break
        case 'finish':
          book.finishGoal(args.note ?? '', args.plan_id)
          break
        case 'abandon':
          book.abandon(args.reason ?? '', args.plan_id)
          break
        case 'list':
          break
        default:
          throw new Error(`action 只支持 ${ACTIONS.join(' / ')}`)
      }
      // timer 只是记个时点，不算一次互动；其余写操作都算。
      if (action !== 'list' && action !== 'timer') book.touch()
      return { agenda: render() }
    },
  })
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)

  ctx.on('agent/created', ({ agent }) => {
    if (!inWorkspace(sessionCwd(ctx, agent), resolved.workspaceRoot)) return
    try {
      registerForAgent(agent, resolved)
    } catch (error) {
      // 注册失败只该让这个会话少两个能力，不该让会话建不起来。
      ctx.logger?.warn?.(`sinecause-goal: 注册失败：${String(error?.message ?? error)}`)
    }
  })
}
