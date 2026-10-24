/**
 * 工作区与状态文件的默认位置。
 *
 * 三种解析顺序：显式配置 → 环境变量 `SINECAUSE_WORKSPACE` → 包的上一级目录。
 *
 * 最后一条只在 `link:` 装法下成立（包目录就在工作区里）。`file:` 装法会把包
 * 复制进 profile 的 `node_modules`，这时"上一级目录"是错的——所以解析结果一旦
 * 落在 `node_modules` 里就**直接报错**，而不是把状态文件悄悄写进依赖目录。
 */

import { isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包目录：`<plugin>/`。 */
export const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

/** 默认工作区：包的上一级目录，`<workspace>/`。 */
export const DEFAULT_WORKSPACE = fileURLToPath(new URL('../..', import.meta.url))

/** 路径里出现这个目录名，说明解析到了依赖树里。 */
function insideDependencyTree(path) {
  return path.split(sep).includes('node_modules')
}

/**
 * 解析工作区根目录。
 * @param {string | undefined} configured - 插件配置里的 workspaceRoot。
 * @param {{ env?: string | undefined, packageParent?: string }} [options] - 测试注入点。
 * @returns {string} 绝对路径。
 * @throws 配置不是绝对路径，或默认解析落进了 node_modules。
 */
export function resolveWorkspaceRoot(configured, options = {}) {
  if (configured !== undefined) {
    if (typeof configured !== 'string' || !isAbsolute(configured)) {
      throw new TypeError('workspaceRoot 必须是绝对路径')
    }
    return configured
  }
  const fromEnv = options.env ?? process.env.SINECAUSE_WORKSPACE
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    if (!isAbsolute(fromEnv)) {
      throw new TypeError(`SINECAUSE_WORKSPACE 必须是绝对路径，收到 ${JSON.stringify(fromEnv)}`)
    }
    return fromEnv
  }
  const fallback = options.packageParent ?? DEFAULT_WORKSPACE
  if (insideDependencyTree(fallback)) {
    throw new Error(
      `工作区解析到了依赖目录（${fallback}）。`
      + '从 npm 或 file: 安装时包就在 node_modules 里，必须显式告诉插件工作区在哪：'
      + '在插件配置（或 profile 的 cordis.patch.yml，按行 id 覆盖）里写 workspaceRoot，'
      + '或设置环境变量 SINECAUSE_WORKSPACE。用 link: 安装则不需要。',
    )
  }
  return fallback
}

/**
 * 解析状态文件路径，默认放在 `<workspace>/state/<file>`。
 * @param {string | undefined} configured - 插件配置里的 statePath。
 * @param {string} workspaceRoot - 已解析的工作区根。
 * @param {string} fileName - 例如 `agenda.json`。
 * @returns {string} 绝对路径。
 */
export function resolveStatePath(configured, workspaceRoot, fileName) {
  if (configured !== undefined) {
    if (typeof configured !== 'string' || !isAbsolute(configured)) {
      throw new TypeError('statePath 必须是绝对路径')
    }
    return configured
  }
  return join(workspaceRoot, 'state', fileName)
}
