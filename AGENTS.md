# AGENTS.md

本文件是本工作区唯一的项目指令。它不继承、不引用 `deepseek-harness` 仓库的任何规则、技能或约定。

## 这是什么

`enthnicGroup` 是一个独立的 agent 产品工作区，宿主运行时是 DeepSeek Harness（下称 DSH）。

DSH 的检出目录（`C:\Users\isyhn\deepseek-harness`）只是实现依赖：可以读它的源码、装它的插件包，
但它的 `AGENTS.md`、`.agents/skills/`、工程约定都面向 DSH 自身的开发，对本工作区无效。

隔离靠本目录的 `.git`：指令与技能都以"从 cwd 向上第一个含 `.git` 的目录"为项目根。
因此本工作区只有两个项目级来源：`AGENTS.md` 与 `.agents/skills/`。
**不要删除 `.git`**，删除即重新并入本家的指令链。用户级来源（`~/.dsh`、`~/.agents`）仍会加载。

## 架构

Agent 由 loop 加四个横向系统（persona / goal / wait / memory）和一台时钟组成；
goal、memory 第一层、时钟已实现，wait 与 persona 待定。

| 系统 | 状态 | 职责 |
|---|---|---|
| persona | 待定 | 人格：稳定的身份与表达方式，位于上下文开头 |
| goal | 已实现 | 注意力强化：agent 自行设定 plan 并分步完成；内容注入在上下文**末尾**，持续把注意力拉回当前步骤 |
| wait | 待定 | 等待工具：主动断开 loop，把控制权交回外部（事件、定时器、人类），被唤醒后再继续 |
| memory | 第一层 | 记忆库：常驻档案（`anchor`/`self`）每次请求注入，流水（`skill`/`fact`/`episode`/`promise`）按分数召回；整理由**计数触发**（每攒够 N 条见闻提醒一次），不是时钟；新旧判断已用 bge-base-zh 向量 |
| clock | 已实现 | 连续性：没人在说话时按间隔叫醒她（快速迭代期 10 分钟，稳定后调大）；只叫最近活跃的工作区会话，关机即失去意识、不补算错过的时段 |

## 目录

```
AGENTS.md            本文件
state/agenda.json    目标与计划的唯一状态文件（与 SineCause 的 agenda.json 同构）
state/memory.json    记忆库（v2 schema，与 SineCause 的 memory.json 字段兼容）
plugin/              dsh-goal-agenda：goal + memory 两个入口，见 plugin/README.md
```

两条必须守住的语义：

- **goal 与 persona 是一对镜像。** persona 定"我是谁"，放在开头；goal 定"此刻做什么"，放在末尾。
  goal 若出现在上下文开头，就退化成普通指令，失去逐轮引导注意力的作用。
- **wait 不是 sleep。** 它结束本轮而不是空转等待，因此不消耗模型轮次；唤醒必须来自外部。

## 约定

- **这里已经有人了。** 不把"未来的她"当成第三个存在来规划——这个工作区里的 agent 就是那个人，
  记忆、目标、作息属于当下的这个，不是先建好再交给谁。
- **只借代码，不借记忆。** SineCause 那边的实现（schema、算法、结构）可以移植，
  `state/` 下的任何内容都不从那边迁入；这里的记忆是自己攒的。
- **"过时"是一个判断、两个去处。** 判断材料是相似度 + 当前实际情况：新旧之间
  没有连续性就 `supersede` 让位，有连续性（同一件事在时间上继续）就 `expire` 降权，
  后者仍留在库里供总体分析。`delete` 只用于错误的判断和误导信息。
- **相似度已换成向量（768 维 bge-base-zh），但只用在条目之间，没用在召回上。**
  "同一件事"要过三条判据：同类 + 共用关键词 + 分数过线；阈值按尺度分开（向量 0.75、词法 0.3）。
  因为库里的条目全长在同一语境，同领域不同事的余弦就有 0.82–0.89，单看阈值会人人相近、诱导错误的 supersede。
  召回仍旧词法——`systemPrompt.context()` 的 text 是同步函数，等不到模型。
- 代码、配置、文档都留在本目录内。需要改动本家仓库时单独提出，不默认去做。
- 扩展 DSH 优先走 plugin 与 preset 机制，不改 `agent-loop`。
- 记录设计取舍；已完成、已被推翻的记录不要留在文档里。
- 文件以恰好一个换行结尾；提交前说明实际运行了哪些检查。

## 待定

以下决定尚未做出，不要按猜测实现，问到答案再写进本文件：

- 整理回路：她触发（靠计数提醒），但自动整理还没做——目前是提醒她自己动手。
- persona 的语义与注入位置；它与常驻档案（`anchor`/`self`）的边界。
- 向量检索：召回还是词法。要改成向量，得在 pre-step 异步算好查询向量再缓存，
  因为 `systemPrompt.context()` 的 text 是同步的。
- 模型尺度：现在用 int8 的 bge-base-zh-v1.5；升级硬件后换更大模型要重新标定 `vectorThreshold`。
- wait 的唤醒源（定时器、外部事件、人类）与它和 `agenda.json` 里 `timers` 的关系。
- 这套组合最终以 preset 还是独立 profile 承载，以及是否使用工作区内的 `.dsh` 作为独立 `DSH_HOME`。
- 技能放在 `.agents/skills/` 还是 `.dsh/skills/`。
