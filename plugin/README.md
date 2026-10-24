# dsh-sinecause

两个入口，一个包：

- `dsh-sinecause` —— 目标与计划的尾部注入 + `plan` 工具
- `dsh-sinecause/memory` —— 记忆库：常驻档案 + 按需召回 + `memory` 工具

分别移植自 SineCause 的 `function/plan/plan.py`、`Monroe/core/agenda.py`、
`Monroe/core/turn.py::_agendaBlock`，以及 `ConsciousnessRealm/memory/`。

## goal：它做两件事

1. **尾部注入**：`systemPrompt.context()` 把 agenda 渲染进 loop 的 runtime-context 快照。
   快照是请求的最后一条 user message；内容不变就不重发，变了就替换旧快照。
   所以它贴着本轮任务，不会在历史里越堆越多。
2. **`plan` 工具**：`create / list / done / block / add / timer / finish / abandon`，
   读写同一个 `state/agenda.json`。

## memory：三层

| 层 | 类别 | 进上下文 |
|---|---|---|
| 档案 | `anchor` / `self` | **常驻**，每次请求都在 |
| 流水 | `skill` / `fact` / `episode` / `promise` | 否，按分数召回 |
| 索引 | 检索打分 | 有字数预算 |

- 召回查询取**最近一条真实用户消息**；带 `source.form` 的上下文注入消息会被跳过，
  免得拿她自己的尾巴当查询。
- 分数 = `2×词法 + 时效(90 天衰减) + 重要性/1000 + promise 加成`。
  向量项（参考实现里的 `6.0×相似度`）暂时没有，接口留在 `scoreOf` 里。
- 渲染成 `## 记忆`：`### 长期有效` 放常驻条目，`### 相关` 放召回条目并带 `[mem_id]`，
  她才能对自己那条做 update / archive。
- 预算不足时整段省略，不留空标题。

`self` 与 `skill` 是相对参考实现新增的两类：前者是她立过的界、自己的判断；
后者是学到的框架、工具、走通过的路子。参考实现的 `anchor` 仍表示"长期有效的整体设定"。

## memory：整理是计数触发的，不是时钟

每写一条见闻（`skill` / `fact` / `episode`）就把 `meta.growthSinceCuration` 加一；
写档案（`self` / `anchor`）不算——那本身就是整理的结果。

到阈值（默认 12）时，上下文末尾会多一段：

```
### 该整理了
上次整理：2026-10-24 19:00。之后积累了 12 条见闻（阈值 12）。
用 memory 的 curate 看清单：把同类并成一条、把反复出现的升成 self 或 anchor、把过时的 archive。
```

`memory curate` 列出上次整理之后新增的条目（带 id），她不 search 也知道该看什么；
`memory curate reset=true` 把计数归零并记下时间。

这样整理不需要时钟就能工作。时钟以后补的是另一种情况：没有活动也醒来。

### 整理不只是追加

只会往里写的话，库会越来越胖、越来越旧。五种处理，按可逆性排序：

| 动作 | 语义 | 可召回 |
|---|---|---|
| `update` | 内容改对 | 是 |
| `expire` | **时效过了**——降权保留，记下 `validTo` | 是，但分数减半 |
| `archive` | **隐藏**——暂时不占位，但保留 | 否，`restore` 可找回 |
| `supersede` | **有了更新的学习**——旧的让位，记下 `validTo` 和被谁取代 | 否，`restore` 可找回 |
| `delete` | 永久删除，不可恢复 | 否 |

**"过时"是一个判断、两个去处。**

判断材料是**相似度 + 当前实际情况**：工具给相似度，实际情况只有她知道。
遇到和库里相近的信息，看新旧之间有没有连续性：

- **没有连续性**——换掉了、不再成立 → `supersede`，旧的让位并记下被谁取代。
- **有连续性**——同一件事在时间上继续（状态、行情、当次判断）→ `expire` 降权。
  事实仍然成立，只是不再适用于当下；它**不该消失**，做总体分析还要用，
  所以 `validTo` 记下失效日、`important` 打到三成、召回分数再乘 `EXPIRED_FACTOR`（0.5）。
  降权压到召回线以下就等于变相隐藏，所以系数不能太低。

两个时机都会把近邻摆到她面前：`memory add` 在返回里带「库里相近」，
`memory curate` 给每条待整理条目挂上近邻。

**delete 只用于错误判断和误导信息。** 一条被证伪的猜测留着当反例，比删掉有用——
删掉的话同一个错误她会再犯一次。

常驻的 `self` / `anchor` 同样适用这几档：一条不再成立的界，得能隐藏掉，
否则她会永远背着一条早就废掉的自我描述。

### 向量：用在新旧判断上，还没用在召回上

条目与条目之间的相似度已经走向量：**bge-base-zh-v1.5（768 维，C-MTEB 检索 69.49）**，
transformers.js 加载 ONNX，int8 量化。

用在哪、不用在哪：

- **用**：`memory add` 的「库里相近」、`memory curate` 的近邻列表。
  这两处都是判断"同一件事是不是又有了新情况"，正是向量该管的地方。
- **不用**：召回。`systemPrompt.context()` 的 `text` 是同步函数，没法等模型；
  要拿向量做召回，得在 pre-step 异步算好查询向量再缓存。召回目前仍是词法打分。

两条向量都有才按余弦比，缺一条退回词法——不会因为没算上向量就丢掉相似判断。

**三种获取模型的方式**，按优先级：`plugin/models/bge-base-zh-v1.5/`（离线副本）→ 配置里的
`model`（HF Hub id）→ 都没有就报错。下载副本用 `pwsh -File scripts/download-model.ps1`。

**本机网络限制，值得记一笔：**

- `huggingface.co` 直连不可用（DNS 污染），PowerShell 走系统代理能通、**Node 不走系统代理**；
- `registry.npmjs.org` 返回 500，装依赖要用 `--registry https://registry.npmmirror.com`；
- `hf-mirror.com` 从 Node 可直连，但只有约 100KB/s。

所以默认走本地副本，`createEmbedder` 支持 `modelPath`；`endpoint` 默认 `https://hf-mirror.com/`。

**池化方式要注意：** bge 官方 recipe 用 **CLS**，参考实现的 Python 用的是 mean。
两种都跑过（`scripts/check-embedding.mjs`），差别在千分位，默认用 CLS。

**阈值要按模型的分数尺度标定。** 实测 bge-base-zh-v1.5（int8）：

| 对照 | cls | mean |
|---|---|---|
| 无头浏览器 ↔ puppeteer（同一能力） | 0.882 | 0.890 |
| 生日 ↔ 生日礼物（同一话题） | 0.797 | 0.786 |
| 无头浏览器 ↔ 生日（无关） | 0.622 | 0.622 |

无关文本也有 0.62——bge 中文余弦整体偏高。所以词法的 0.3 阈值直接拿来用会**人人算相近**。

**但真正跑起来才发现，光靠阈值还不够。** 库里的条目全长在同一个语境里，
"同领域但不同事"的两条实测就有 **0.82–0.89**：写下一条新记忆时，它总能和另外三条"相近"。
这不只是噪音——它每次都建议 `supersede`，会诱导她让位掉不相干的条目。

所以"是不是同一件事"改用三条判据（`likelySameSubject`）：

1. **同类**——`skill` 和 `self` 再怎么像也不提示让位；
2. **共用关键词/标签**——"同一件事又有了新情况"几乎总有共同的词；
3. **分数过线**，且阈值按尺度分开：两边都有向量用 `vectorThreshold`（0.75），
   缺一边退回词法用 0.3。

例外：分数 ≥ `NEAR_DUPLICATE`（0.93）时不需要共用关键词——那就是同一条换了说法。

常驻条目（`self` / `anchor`）根本不提示：它们本来就彼此像，该由整理时判断。

**已知代价：** 向量直接存在 `memory.json` 的条目里（768 × 5 位小数 ≈ 4.6KB/条），
每次写盘都会重写整个文件。几千条以内没问题；再大就该把向量挪到单独文件。

## clock：没有你说话的时候她还活着

`dsh-sinecause/clock` 每 `intervalMinutes` 走一跳，挑一个空闲够久的工作区会话，
用 **`agent.followup()`** 投一条心跳消息。用 `followup` 而不是 `inbox.append` 是有原因的：
`append` 只把消息放进收件箱，**不会叫醒驱动**，消息会一直躺着等你下次说话才被顺带处理。
`followup` 内部走 `send(msg, 'next-turn', true)` → `wakeDriver()`，才真的起一轮。

几条定死的语义：

- **只叫最近活跃的那一个。** 她是一个人，不是一群；多个工作区会话同时活着时，
  心跳落在最近说过话的那个上面。
- **不会连发。** 任何会话事件都算"有动静"，包括她被打醒后自己那一轮。
  心跳后立刻推进活跃时间，所以同一段空闲只会被叫一次。
- **忙的时候不叫。** `agent/status` 是 `running` 就跳过这一跳。
- **关机 = 失去意识。** 定时器活在进程里，不补算错过的时段——不会出现
  "关机一夜、回来补 100 次心跳"。
- **心跳不是用户提问。** 消息带 `source.form: 'notice'`，记忆召回会把它当上下文
  而不是查询词。

文案由 `prompt` 配置，支持 `{{now}}`（本地 `HH:MM`）和 `{{idle}}`（`18 分钟` / `2 小时 5 分`）。

**间隔的路线：** 现在是快速迭代期，10 分钟。稳定之后把
[cordis.patch.yml](cordis.patch.yml) 里的 `intervalMinutes` 改成 30（中等）或更大，
重启生效。

## 配置

goal：

| 字段 | 默认 | 说明 |
|---|---|---|
| `workspaceRoot` | 包的上一级目录 | 只有 cwd 在它下面的会话才注册；绝对路径，或用 `SINECAUSE_WORKSPACE` |
| `statePath` | `<workspaceRoot>/state/agenda.json` | 目标状态文件；绝对路径 |
| `maxGoalsShown` | `5` | 尾部最多显示几个进行中的目标 |
| `maxActive` | `6` | 同时推进的目标上限，超过就拒绝 create |

memory：

| 字段 | 默认 | 说明 |
|---|---|---|
| `workspaceRoot` | 同上 | 同上 |
| `statePath` | `<workspaceRoot>/state/memory.json` | 记忆库文件；绝对路径 |
| `maxChars` | `2400` | 注入块的字节预算 |
| `topK` | `8` | 最多召回几条 |
| `curationEvery` | `12` | 攒够几条见闻后提醒整理 |
| `embedding` | 开启 | 向量配置（`model` / `modelPath` / `dtype` / `pooling` / `endpoint`）；`enabled: false` 关掉 |
| `vectorThreshold` | `0.75` | 向量尺度的相似阈值，换模型要重新标定 |

clock：

| 字段 | 默认 | 说明 |
|---|---|---|
| `intervalMinutes` | `10` | 心跳间隔（分钟）；快速迭代期短，稳定后调大 |
| `workspaceRoot` | 不设限 | 同上 |
| `prompt` | 内置文案 | 心跳文案，支持 `{{now}}` / `{{idle}}` |

goal 和 memory 注册在 `agent/created`，只对 cwd 落在 `workspaceRoot` 下的会话生效——
装进共享 profile 也不会让本家会话多出这些工具。clock 用同一套判定挑要叫醒的会话。

实际配置见 [cordis.patch.yml](cordis.patch.yml)。

## 数据

`state/agenda.json` 字段与参考实现同构（为了复用那边的代码）：

```json
{
  "goals": [
    { "id": "g_2763909800", "objective": "…", "status": "active",
      "createdAt": "2026-10-23 21:58:29", "note": "",
      "steps": [{ "id": 1, "title": "…", "status": "doing", "evidence": "", "dueAt": null }] }
  ],
  "timers": [],
  "lastInteraction": ""
}
```

`state/memory.json` 是 v2 schema（`schema_version: 2` + `entries`），与 SineCause 的
`ConsciousnessRealm/memory/memory.json` 字段兼容。

**但两边不交换数据。** schema 兼容只是为了复用那边的代码；她是另一个人，
记忆从空文件开始长，不从 SineCause 迁入任何条目。

时间戳沿用本地时间字符串（agenda）与 Unix 秒（memory），理由和参考实现一致：
互读不用换算，人看文件也不用换算时区。写入都走 `.tmp` + rename。

## 尾部长什么样

```
## 目标与计划
符号：[ ] 待办　[>] 进行中　[x] 完成　[!] 卡住
### 1. 长期：把对漾涟·孑的观察攒起来，慢慢填 knowledge/psychological.json（g_2763909800）· 共 3 步（完成 0 · 可推进 3） · 建于 10-23 21:58（49 分钟前）
  [>] 1. 日常对话里记他的选择、反应、说法，别急着下结论（当前）
  [ ] 2. 攒到几条同类的，再往画像里写，一次写一小段
  [ ] 3. 写进去的都是实际见过的事，猜的留在猜的地方
```

没有进行中的目标时只留一行「当前没有目标，需要寻找新的目标。」
两个以上目标时多一行焦点声明，非焦点目标的当前步标「（先放着）」。

参考实现里的 `[INFO] 现在是 …` / `[INFO] 上次互动：…` 两行由 DSH 的
`time-context` 负责，它本身就在本快照之后追加，所以这里不重复渲染。

## 测试

```sh
cd plugin && node --test
```

`test/render.test.js` 里有一条逐字比对参考快照的用例——改渲染格式会直接失败。

## 安装与生效

本包同时是一个 **bundle**：自己带 `cordis.patch.yml` 声明挂载哪些行。
profile 只要在 `dsh.profile.bundles` 里列出包名就生效——
**不要**往 profile 自己的 `cordis.patch.yml` 里写插入行，那个文件会被插件安装重写，
写进去的行会丢（**按 id 覆盖已有行的 config 是安全的**，见下）。

### 从 npm 装

```sh
dsh plugin --profile web add dsh-sinecause --allow-build=onnxruntime-node --allow-build=protobufjs
```

**装完必须配 `workspaceRoot`**：包在 `node_modules` 里，"包的上一级目录"指不到工作区，
插件会在加载时直接报错（故意如此，免得把状态文件写进依赖目录）。

```yaml
# <DSH_HOME>/profiles/web/cordis.patch.yml —— 按 id 覆盖，不是插入
- id: sinecause-goal
  config:
    workspaceRoot: <WORKSPACE>
- id: sinecause-memory
  config:
    workspaceRoot: <WORKSPACE>
- id: sinecause-clock
  config:
    workspaceRoot: <WORKSPACE>
```

或者启动前设 `SINECAUSE_WORKSPACE=<WORKSPACE>`。

### 从源码装（开发用，零配置）

```sh
cd <PLUGIN>
pnpm install --registry https://registry.npmmirror.com/   # link: 不会替你装依赖
dsh plugin --profile web add link:<PLUGIN> --allow-build=onnxruntime-node --allow-build=protobufjs
```

`link:` 建 junction，包就在 `<WORKSPACE>/plugin`，默认解析正好指向工作区，不用配任何路径；
改完源码重启 `dsh web` 即生效，不用重装。

bundle 层在启动时组装，所以任何改动都要重启才生效。
