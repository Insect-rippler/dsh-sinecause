/**
 * 工作区判定：会话 cwd 是否落在配置的 workspaceRoot 下。
 *
 * 两边都要先规范化再比——配置里习惯写正斜杠（`C:/Users/...`），而会话 cwd
 * 是反斜杠（`C:\Users\...`），字面量比较会永远不相等，结果就是插件加载了却
 * 一个会话都不注册。Windows 上还要按大小写不敏感比。
 */

import { normalize, sep } from 'node:path'

/** Windows 路径大小写不敏感；其他平台保持原样。 */
const ignoreCase = process.platform === 'win32'
  ? value => value.toLowerCase()
  : value => value

/**
 * cwd 是否落在工作区内。
 * @param {string | undefined} cwd - 会话工作目录。
 * @param {string | undefined} workspaceRoot - 配置的工作区根；undefined 表示不过滤。
 * @returns {boolean}
 */
export function inWorkspace(cwd, workspaceRoot) {
  if (workspaceRoot === undefined) return true
  if (typeof cwd !== 'string' || cwd === '') return false
  const root = ignoreCase(normalize(workspaceRoot)).replace(/[\\/]+$/, '')
  const target = ignoreCase(normalize(cwd))
  return target === root || target.startsWith(root + sep)
}
