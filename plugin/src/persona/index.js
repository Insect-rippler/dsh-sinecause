/**
 * sinecause-persona — 人格：放在系统提示最前面的"我是谁"。
 *
 * 和 goal 是一对镜像：goal 定"此刻做什么"，在上下文末尾、可以改可以弃；
 * persona 定"我是谁"，在系统提示开头、改动要慢得多。
 *
 * 位置不是随便挑的：DSH 的 system-prompt 自带一张顺序表，
 * `HARNESS_IDENTITY: -1000` 是宿主的身份，`DEPLOYMENT_PERSONA_PREFIX: 0` 是留给人格的空槽，
 * 再往后才是 `PLAN_POLICY: 500` 和各种工具说明。我们占了紧接其后的 order 1——
 * 在一切可执行规则之前，这就是"人格先于行动"在实现上的样子。
 *
 * 内容来自工作区的 `state/persona.md`：由她自己写，写得慢、改得慎重。
 * 文件不存在或为空时什么都不注入——没有就是没有，不拿默认人设填坑。
 */

import { readFileSync, statSync } from 'node:fs'

import { resolveStatePath, resolveWorkspaceRoot } from '../paths.js'
import { installTailChannel, registerContextBlock, registerRequestPrefix } from '../tail.js'
import { inWorkspace } from '../workspace-gate.js'

/** Cordis 插件名。 */
export const name = 'sinecause-persona'

/** 依赖的服务。 */
export const inject = ['systemPrompt', 'llm']

/** 紧跟 DEPLOYMENT_PERSONA_PREFIX（order 0）之后，早于一切策略与工具说明。 */
export const DEFAULT_ORDER = 1

/**
 * 宿主预留给「人格前缀」的那个 section 名字（system-prompt 包的 PERSONA_PREFIX_SECTION）。
 * 在 Agent 自己的 scope 里注册同名 section 会**顶替**全局那一份，而不是并存——
 * 所以这里不是"再插一段"，而是"接管那个槽"。
 */
export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'

/** persona 的字数上限。超过这个数说明在写废话，而不是在写自己。 */
export const DEFAULT_MAX_CHARS = 1200

/**
 * 尾部回声的位置：排在记忆（250）与目标（300）之前。
 *
 * 为什么要在尾部再说一遍：系统提示的注意力会随上下文变长而衰减
 * （1000 token 在 2000 里占一半，在 80000 里只剩百分之一）。
 * 开头和结尾是最能牵引注意力的两个位置，**同一件事在两处各说一次是必要的**——
 * 对人格尤其如此：它优先于一切，最不能掉。
 */
export const DEFAULT_ECHO_ORDER = 250

/**
 * 校验配置。
 * @param {object} [config]
 * @returns {{ workspaceRoot: string, personaPath: string, maxChars: number, order: number, echo: boolean, echoOrder: number }}
 */
export function resolveConfig(config) {
  const workspaceRoot = resolveWorkspaceRoot(config?.workspaceRoot)
  const personaPath = resolveStatePath(config?.personaPath, workspaceRoot, 'persona.md')
  const maxChars = config?.maxChars ?? DEFAULT_MAX_CHARS
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new TypeError('sinecause-persona: maxChars 必须是正整数')
  }
  const order = config?.order ?? DEFAULT_ORDER
  if (!Number.isFinite(order)) {
    throw new TypeError('sinecause-persona: order 必须是数字')
  }
  const echo = config?.echo ?? true
  if (typeof echo !== 'boolean') {
    throw new TypeError('sinecause-persona: echo 必须是布尔值')
  }
  const echoOrder = config?.echoOrder ?? DEFAULT_ECHO_ORDER
  if (!Number.isFinite(echoOrder)) {
    throw new TypeError('sinecause-persona: echoOrder 必须是数字')
  }
  return { workspaceRoot, personaPath, maxChars, order, echo, echoOrder }
}

/**
 * 读 persona 正文。按 mtime 缓存，避免每一轮都碰磁盘。
 * @param {string} path
 * @param {number} maxChars
 * @param {{ path: string, mtimeMs: number, text: string } | undefined} cache
 * @returns {{ text: string, cache: { path: string, mtimeMs: number, text: string } }}
 */
export function readPersona(path, maxChars, cache) {
  try {
    const stat = statSync(path)
    if (cache !== undefined && cache.path === path && cache.mtimeMs === stat.mtimeMs) {
      return { text: cache.text, cache }
    }
    const raw = readFileSync(path, 'utf8').trim()
    // 超长说明写坏了：宁可截断也不要让一段自我描述挤掉工具说明。
    const text = raw.length <= maxChars ? raw : `${raw.slice(0, maxChars).trimEnd()}…`
    const next = { path, mtimeMs: stat.mtimeMs, text }
    return { text, cache: next }
  } catch {
    // 不存在、读不了：就是没有人格内容，不编。
    return { text: '', cache }
  }
}

/**
 * 安装。
 * @param {any} ctx
 * @param {object} [config]
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  // 生产里唯一真正收到 llm/stream 的入口。
  installTailChannel(ctx)
  let cache

  const body = () => {
    const result = readPersona(resolved.personaPath, resolved.maxChars, cache)
    cache = result.cache
    return result.text
  }

  ctx.on('agent/created', ({ agent }) => {
    // 子代理是她的工具，不是另一个人格。
    if (agent.session?.header?.origin === 'subagent') return
    const cwd = sessionCwd(ctx, agent)
    if (!inWorkspace(cwd, resolved.workspaceRoot)) return

    // 注册时已经按工作区筛过了。这里不再重复判一次：
    // 那个判据一旦因为取不到 cwd 而返回空串，整段人格就会静默消失——实测栽过一次。
    const live = () => body()

    // 人格放进系统提示的最前面：接管 `deployment:persona-prefix` 这个槽。
    //
    // `agent.ctx` 就是这个 Agent 自己的 scope（agent-loop 里 `this.ctx = this.scope.ctx`），
    // 在它上面注册的 section 只对这一路请求生效，并顶替全局同名的那一份。
    //
    // 之前走 `llm/stream` 改 `options.messages` 为什么一个字都进不去：loop 交给适配器的
    // 请求是 **deepFreeze 过的**（agent-loop `deepFreeze(request)` + 每条 message 都冻结），
    // 赋新值只会抛 TypeError，被 patch() 的 try 全吃掉——表现就是"代码跑了、请求没变"。
    // `llm/stream` 只能读，不能写。
    installPersonaSection(agent, live, resolved.order)

      // 尾部的同一份，换个标题：它不是重复，是注意力锚点。
      // 走 runtime-context 快照（同名替换，不累积）；order 大于记忆，所以它更贴近本轮触发。
      if (resolved.echo) {
        registerContextBlock(agent, {
          name: 'sinecause:persona-echo',
          order: resolved.echoOrder,
          text: () => {
            const text = live()
            return text === '' ? '' : `## 立场\n\n${text}`
          },
        })
      }
  })
}

/**
 * 把人格挂到该 Agent 的系统提示前缀槽上。
 *
 * 宿主没有 systemPrompt 服务时（单测里的假 ctx）退回旧的 `llm/stream` 前缀改法，
 * 保证离线测试仍能驱动同一条组装路径。
 *
 * @param {any} agent
 * @param {() => string} render
 * @param {number} order
 * @returns {() => void} 注销
 */
export function installPersonaSection(agent, render, order = DEFAULT_ORDER) {
  try {
    const prompt = agent.ctx?.systemPrompt
    if (typeof prompt?.section === 'function') {
      // text 给函数：每一轮都会重新读 persona.md（内部按 mtime 缓存），不必重注册。
      return prompt.section({ name: PERSONA_PREFIX_SECTION, order, text: () => render() })
    }
  } catch {
    // 服务接口变了也不能让会话建不起来，下面退回旧路。
  }
  registerRequestPrefix(agent, render)
  return () => {}
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
