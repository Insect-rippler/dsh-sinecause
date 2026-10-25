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
import { PLACEMENT, TAIL_ORDERS, registerTailBlock } from '../tail.js'
import { inWorkspace } from '../workspace-gate.js'

/** Cordis 插件名。 */
export const name = 'sinecause-persona'

/** 依赖的服务。 */
export const inject = ['systemPrompt']

/** 紧跟 DEPLOYMENT_PERSONA_PREFIX（order 0）之后，早于一切策略与工具说明。 */
export const DEFAULT_ORDER = 1

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
export const DEFAULT_ECHO_ORDER = 240

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

    try {
      // 人格直接拼到请求里那条 system 消息的最前面。
      //
      // 试过两条"正规"的路，都不行：
      // - `systemPrompt.section()` / `agent.ctx.inject(scope).section()`：实测系统提示里
      //   一个字都没有（`promptdump` 拍到的全文 5775 字，不含人格）。
      // - `system-prompt/assemble` 里 push：`AssembledSection` 没有 order 字段，
      //   只能排在最后，永远到不了开头。
      //
      // 所以走和记忆/目标同一条已验证的钩子：`llm/stream`。区别只是改的是第一条
      // system 消息的开头，而不是末尾追加。同样只影响这一份请求，不落库。
      agent.ctx.on('llm/stream', (options, next) => {
        try {
          if (String(options?.sessionId) !== String(agent.id)) return next()
          const text = live()
          const first = options?.messages?.[0]
          if (text !== '' && first?.role === 'system' && Array.isArray(first.content)) {
            const [head, ...rest] = first.content
            if (head?.type === 'text') {
              options.messages = [
                { ...first, content: [{ ...head, text: `${text}\n\n${head.text}` }, ...rest] },
                ...options.messages.slice(1),
              ]
            }
          }
        } catch {
          // 拼装失败也不该让请求发不出去。
        }
        return next()
      })
    } catch (error) {
      ctx.logger?.warn?.(`sinecause-persona: 注册失败：${String(error?.message ?? error)}`)
    }

      // 尾部的同一份，换个标题：它不是重复，是注意力锚点。
      // 走"请求时组装"而不是 context()——后者会被写成 durable 快照塞进历史，
      // 每变一次多一份，旧的那份还会假装是当前。
      if (resolved.echo) {
        registerTailBlock(agent, {
          name: 'sinecause:persona-echo',
          order: TAIL_ORDERS.stance,
          // 和记忆一起插在本轮 user 消息之前；立场排在记忆之内、最贴近这一轮的请求。
          placement: PLACEMENT.beforeUser,
          text: () => {
            const text = live()
            return text === '' ? '' : `## 立场\n\n${text}`
          },
        })
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
