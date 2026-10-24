# `wait` 设计稿：怎么干净地结束一轮

> 状态：设计，未实现。写完这一稿的结论是：**卡点不在"什么时候醒"，在"怎么睡"。**

## 1. 要什么

她说："这件事现在做不了，等 X 再继续。" 然后：

- 本轮**立刻结束**，不再继续烧模型轮次；
- 到点（或条件满足）**自动醒**；
- 醒来的那一轮知道自己是被什么叫醒的。

现在 `clock` 只能单向叫醒——它不知道她有话没说完；`plan` 里的 `timers` 记录了时点但没人消费。

## 2. 卡点：DSH 没有"这轮结束"这个工具能力

翻遍 `packages/core/tools/src`，工具能拿到 `signal`、能 `deferContext`，但**没有 endTurn / stopTurn**。
一轮怎么结束，是由 agent-loop 单方面决定的。

`turn/end` 的 reason 有五类（`packages/core/session/src/types.ts:202`）：
`completed` / `blocked` / `aborted` / `error` / `max-tokens`，且这个 map 是**可合并扩展**的——
但**只有 loop 内部能写**，插件无法让某一轮以自定义 reason 结束。

所以"睡"只能借现有的出口。

## 3. 三条出口，逐个算代价

| 方式 | 机制 | turn/end | 问题 |
|---|---|---|---|
| **A. pre-step reject** | 工具置"等待中"标记，下一个 `agent/pre-step` 返回 `{kind:'reject'}` | `blocked` | 语义挪用：`blocked` 本来是"这一步被挡下"，日志和界面都会按"卡住"呈现 |
| **B. cancel** | 工具内 `agent.cancel({kind:'hook', reason})` | `aborted` + cause | 更像故障：abort 会走取消路径，inbox 默认被清（除非 `keepInbox`） |
| **C. 软收轮** | 工具结果里写"别继续了"，靠模型自觉 | `completed` | 不确定。模型完全可以接着调工具 |

**A 是唯一确定性的**：`reject` 在 loop 里直接 `turnEnds = {kind:'blocked'}` 然后 break
（`agent-loop/src/agent.ts:319-322`），不依赖模型配合。

代价是语义——`blocked` 会被读成"卡住"。有两条缓解：

1. `wait` 的工具结果里把话说清楚（"本轮已按你的要求结束"），模型看得见；
2. 醒来那一轮把 `blocked` 当作正常状态，不当故障。

如果以后 DSH 允许插件贡献 turn/end reason（map 已经是 merge-extensible，只差 loop 愿意采信），
可以把 `blocked` 换成 `waiting`。**这是应该向上游提的**，不是我们能绕开的。

## 4. 唤醒从哪来

| 来源 | 能不能用 | 说明 |
|---|---|---|
| `ctx.schedule.create(sessionId, {...})` | ✅ **已查实** | Host 侧持久化，重启后仍在，到点以普通后续消息投递 |
| 外部事件（文件、网页、消息） | ❌ 现在不行 | 需要一个 Host 侧往会话投消息的东西，`schedule` 只解决定时 |
| 时钟顺带醒来 | ✅ 但语义不同 | 时钟是"到点看一眼"，`wait` 是"等某个条件"，不该混用 |

所以第一版只做定时唤醒。

### 4.1 它能叫醒没加载的会话（关键）

`schedule/src/runtime.ts:101-124` 的投递路径是：

```ts
const resolved = await this.ctx.sessionController.resolveAgent(task.sessionId)  // 未加载就激活
if ('error' in resolved) throw resolved.error
const message = createUserMessage({ content: [...], source: { kind: 'schedule' } })
resolved.agent.followup(message)          // 起一轮
const flushed = await this.ctx.sessions.flush(resolved.agent.session)  // 落盘确认
```

三点结论：

1. **跨重启成立。** 定时任务在 Host 侧持久化，重启后扫描 `scheduledAt <= now`，
   过期的会在启动时补投一次——所以 `wait` 睡过一段时间再开机也能醒。
2. **它自己会激活会话**，不需要会话先被打开。
3. **投递是"后续消息"**，走的是正常 `followup`，和用户发言同一条路径——所以醒来那一轮
   上下文完整，不需要特殊处理。

## 5. 设计

```
wait { at?: 'HH:MM' | 'YYYY-MM-DD HH:MM', afterSeconds?: number, reason?: string }
```

执行顺序：

1. `schedule.create(sessionId, { at, prompt })` —— 先落盘，醒了才算数；
2. 把 `{ wakeAt, reason, sessionId }` 写进 `state/agenda.json` 的 `timers`（复用已有字段）；
3. 置内存标记 `waiting`；
4. 下一个 `agent/pre-step` 看到标记 → 清标记、返回 `reject`；
5. 唤醒消息到达 → 新一轮，模型在尾部看到 `## 目标与计划` 里的定时器已到期。

**几个边界：**

- **等两次**：新的 `wait` 覆盖旧的——先删掉上一条 schedule，再建新的。
- **等待中被打断**（用户说话）：正常开一轮，`waiting` 标记作废，schedule 保留（到点仍会响一次）。
- **重启**：schedule 在 Host 侧，唤醒不丢；内存标记重置，所以醒来那一轮不会误判成"还在睡"。
- **连续两次 reject**：`wait` 只置一次标记，且 pre-step 消费后立即清除，不会连坐下一轮。

## 6. 验证清单

1. ~~`schedule.create` 能否对**未加载**的会话投递？~~ **已查实：能。**
   `runtime.ts` 先 `resolveAgent` 激活会话，再 `followup`，再 flush（见 4.1）。
   跨重启也成立：过期任务在启动扫描时补投。
2. UI 把 `blocked` 渲染成什么？如果显示成红色错误，A 方案的用户观感要重新评估。
3. 模型在收到 `wait` 结果后、被 reject 之前，还会不会调别的工具？—— 实测一轮日志。

## 7. 不做

- 不改 `agent-loop`（本工作区的规矩）。
- 不做条件等待（"等文件出现"）——那需要外部事件源，单列。
- 不与 clock 合并：clock 是作息，wait 是等待，语义不同，混在一起会让两者都说不清。
