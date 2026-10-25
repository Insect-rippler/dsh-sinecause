/**
 * 每个会话自己的心跳门槛。
 *
 * 默认门槛来自配置（`intervalMinutes`）。她可以用 `heartbeat` 工具把它调大——
 * "这事两小时内没戏，别每十分钟叫我一次"——醒一次之后自动回到默认。
 *
 * 落在状态文件里而不是内存里：重启之后还没着的等待不该消失。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA_VERSION = 1

/** 一条门槛：安静多少毫秒之后叫醒。 */
function normalizeRecord(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const idleMs = Number(raw.idleMs)
  if (!Number.isFinite(idleMs) || idleMs <= 0) return null
  const setAt = Number(raw.setAt)
  return { idleMs, setAt: Number.isFinite(setAt) ? setAt : 0 }
}

export class HeartbeatStore {
  /** @param {string} path - 状态文件路径。 */
  constructor(path) {
    this.path = path
    this.cache = undefined
  }

  /** 全部门槛；文件缺失或损坏时当作空，不要因为读不了就不跳了。 */
  all() {
    if (this.cache !== undefined) return this.cache
    const table = {}
    try {
      if (existsSync(this.path)) {
        const raw = JSON.parse(readFileSync(this.path, 'utf8'))
        for (const [id, record] of Object.entries(raw?.entries ?? {})) {
          const normalized = normalizeRecord(record)
          if (normalized !== null) table[id] = normalized
        }
      }
    } catch {
      // 坏文件等于没有门槛——默认节拍照旧走。
    }
    this.cache = table
    return table
  }

  /** 某个会话的门槛；没有就返回 undefined（用默认）。 */
  get(sessionId) {
    return this.all()[String(sessionId)]
  }

  /** 设门槛（毫秒）。 */
  set(sessionId, idleMs, now = Date.now()) {
    const table = { ...this.all() }
    table[String(sessionId)] = { idleMs: Math.trunc(idleMs), setAt: Math.trunc(now) }
    this.write(table)
  }

  /** 清掉门槛，回到默认节拍。 */
  clear(sessionId) {
    const id = String(sessionId)
    const current = this.all()
    // 没有门槛就不要写盘：时钟每次叫醒都会清一次，白写会把状态文件的 mtime
    // 刷成一跳一次，也会让"这个文件有内容"这件事变得不可信。
    if (!Object.hasOwn(current, id)) return
    const table = { ...current }
    delete table[id]
    this.write(table)
  }

  write(table) {
    this.cache = table
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(
        this.path,
        `${JSON.stringify({ schema_version: SCHEMA_VERSION, entries: table }, null, 2)}\n`,
        'utf8',
      )
    } catch {
      // 写不进去就只在内存里生效：这一轮省下的唤醒仍然算省下了。
    }
  }
}
