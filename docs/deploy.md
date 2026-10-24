# 部署教程：在 DSH 上跑起「目标 / 记忆 / 时钟」

这份文档写给**另一台机器**上的部署者：把三个插件（goal、memory、clock）装进一份 DSH，
让一个工作区里的会话拥有自己的目标、记忆和作息。

它不做的事情：不介绍这套东西为什么这么设计（那是各入口的 README 的事），
也不假装它已经完成——最后一节列了还没做的部分。

---

## 0. 它是什么

四个部件，缺一不可：

| 部件 | 作用 | 装在哪 |
|---|---|---|
| **插件包** `dsh-sinecause` | 三个 Cordis 插件入口：`/`（goal）、`/memory`、`/clock` | DSH profile 的依赖 |
| **工作区隔离** | 一个 `.git` 目录，让这个工作区成为独立的项目根 | 你的工作区 |
| **状态文件** | `agenda.json`（目标）、`memory.json`（记忆） | 你的工作区 `state/` |
| **向量模型** | 768 维 bge-base-zh，判断"同一件事又有了新情况" | 插件包的 `models/`，或 HF 缓存（见第 6 节） |

工作区隔离这一步容易被忽略，但它是"她只活在这个工作区"的前提：
DSH 用"从 cwd 向上第一个含 `.git` 的目录"判定项目根，
没有它，工作区会并进上层仓库的指令链。

---

## 1. 前置条件

| 项 | 要求 | 检查 |
|---|---|---|
| Node | `^22.19.0 \|\| >=24.0.0` | `node -v` |
| DSH | 能跑 `dsh web`（本教程在 `0.2.1-rc.2` 上验证） | `dsh --version` |
| pnpm | 11.x | `pnpm -v` |
| 磁盘 | 约 250MB（模型 98MB + onnxruntime） | — |

网络上有两个坑，先确认再装（见第 8 节）：`registry.npmjs.org` 在部分网络不可用；
`huggingface.co` 可能被 DNS 污染。

---

## 2. 放置文件

**从 npm 装**时没有这一步——包会进 `<DSH_HOME>\profiles\web\node_modules\`，
直接跳到第 3 步。只有想改源码（`link:` / `file:` 装法）才需要把 `plugin/` 拷过来：

```powershell
git clone https://github.com/Insect-rippler/dsh-sinecause
# 或直接把 plugin/ 整个拷到目标位置
```

两种装法都用这套占位符：

```
<WORKSPACE>   你的工作区，例如 D:\agents\sinecause
<PLUGIN>      插件包位置，例如 <WORKSPACE>\plugin（仅源码装法需要）
<DSH_HOME>    默认 ~/.dsh
```

建议的结构（源码装法）：

```
<WORKSPACE>/
  .git/                    ← 必须有，见第 3 步
  AGENTS.md                ← 这个工作区的规矩（可选但建议）
  state/
    agenda.json            第一次写入时自动创建
    memory.json            第一次写入时自动创建
  plugin/                  插件包本体（npm 装法没有这一层）
    src/index.js           目标：尾部注入 + plan 工具
    src/agenda.js          目标状态机
    src/render.js          尾部渲染
    src/memory/            记忆：常驻档案、召回、向量、整理
    src/clock/             心跳
    src/paths.js           工作区与状态文件的默认解析
    src/workspace-gate.js  工作区判定
    cordis.patch.yml       ← 挂载声明（多数情况不用改）
    scripts/download-model.ps1
```

---

## 3. 建立工作区隔离

```powershell
cd <WORKSPACE>
git init
```

**不要删除这个 `.git`。** 删掉意味着这个工作区重新并进上层的指令链和技能链。

（如果你不想引入 git 仓库，也可以只建一个空目录名为 `.git`——判定只看它是否存在。）

然后写一份 `AGENTS.md`，至少写清楚：这是独立工作区、不继承上层规则、
以及状态文件放在哪。

---

## 4. 配置工作区（多数情况不用配）

`cordis.patch.yml` 里**没有绝对路径**。工作区按这个顺序解析：

1. 插件配置里的 `workspaceRoot`
2. 环境变量 `SINECAUSE_WORKSPACE`
3. 包的上一级目录（`<PLUGIN>/..`）

状态文件默认放在 `<workspaceRoot>/state/` 下，按需创建。

所以：

| 安装方式 | 包实际在哪 | 要不要配 |
|---|---|---|
| npm（`dsh-sinecause`） | profile 的 `node_modules` | **必须配**——默认解析会落进依赖目录 |
| `file:<PLUGIN>` | profile 的 `node_modules` | **必须配** |
| `link:<PLUGIN>`，包在 `<WORKSPACE>/plugin` | 就是工作区里那份 | **不用**，第 3 条正好指向工作区 |

**要配的时候，改 profile 的文件，不要改包里的。** 写这个文件
（`<DSH_HOME>\profiles\web\cordis.patch.yml`）——它是**按行 id 覆盖配置**，
不是插入新行，所以不会被插件安装冲掉：

```yaml
- id: sinecause-goal
  config:
    workspaceRoot: <WORKSPACE>

- id: sinecause-memory
  config:
    workspaceRoot: <WORKSPACE>

- id: sinecause-clock
  config:
    intervalMinutes: 10          # 快速迭代期用 10，稳定后改 30 或更大
    workspaceRoot: <WORKSPACE>
```

也可以不改文件，改成启动前设 `SINECAUSE_WORKSPACE=<WORKSPACE>`。

如果是**源码装法**、又想把这套配置固化进仓库，就改 `<PLUGIN>/cordis.patch.yml`
（bundle 自带的挂载声明），格式是 `- insert:` 加三行完整声明——源码里那份现在是
零路径的，照着加 `config.workspaceRoot` 即可。

**忘了配会怎样：** 三个插件全部加载失败，启动**不会**因此中止，只在末尾 warn
一句 `3 entries did not activate`——表现为"工具消失了"。原因写在报错里：
`工作区解析到了依赖目录`。这是故意的：静默把状态文件写进 `node_modules` 更难查。

**正斜杠反斜杠都行**，但 `workspaceRoot` 必须在规范化后与会话 cwd 相等
（插件会 normalize 并忽略大小写；早期版本这里有个致命 bug，见第 8 节）。

---

## 5. 安装进 profile

### 5.1 先完全退出 DSH

安装会改 profile 的 `package.json` 并重装依赖。**应用开着的时候不要装**，装完再启动。

### 5.2 装包

**从 npm 装**（推荐）：

```powershell
dsh plugin --profile web add dsh-sinecause --allow-build=onnxruntime-node --allow-build=protobufjs
```

**装完必须配 `workspaceRoot`**——从 npm 装的包在 `node_modules` 里，
"包的上一级目录"指不到工作区。按第 4 节写 profile 的 `cordis.patch.yml`，或设
`SINECAUSE_WORKSPACE`。不配的话插件会在加载时直接报错。

**从 git 检出装**（零配置，适合改源码）：

```powershell
# 先给插件目录自己装依赖——link: 不会替它装
cd <PLUGIN>
pnpm install --registry https://registry.npmmirror.com/

# 再挂进 profile
dsh plugin --profile web add link:<PLUGIN> --allow-build=onnxruntime-node --allow-build=protobufjs
```

`link:` 时包就在 `<WORKSPACE>/plugin`，默认解析正好指向工作区，**不用配任何路径**。

如果 DSH 是**源码检出**、`dsh` 不在 PATH 上，两种装法都把 `dsh plugin` 换成
`pnpm dsh plugin`（在检出目录里执行）。

**那两个 `--allow-build` 不能省。** 插件依赖 `@huggingface/transformers`，它以
`onnxruntime-node` 和 `protobufjs` 作为后端，pnpm 11 默认不跑这两个包的安装脚本；
一旦拒绝，pnpm 直接以 `ERR_PNPM_IGNORED_BUILDS` 退出 1，整个安装失败。

（Windows x64 上 onnxruntime 的 CPU 二进制本来就随包附带、不需要下载——但 pnpm
仍然要求显式放行才肯继续。这一点和"要不要下载"是两件事。）

### 5.3 三种装法的差别

| 装法 | 依赖 | 工作区解析 | 适用 |
|---|---|---|---|
| npm（`dsh-sinecause`） | 自动装进 profile | **要配 `workspaceRoot`** | 部署、跟进版本 |
| `link:<PLUGIN>` | 要自己 `pnpm install` | 零配置 | 改源码、调试 |
| `file:<PLUGIN>` | 自动装进 profile | **要配 `workspaceRoot`** | 冻结副本 |

### 5.3.1 `link:` 的额外准备

链接依赖**不会**替插件安装它自己的依赖，所以先手动装一次：

```powershell
cd <PLUGIN>
pnpm install --registry https://registry.npmmirror.com/
```

（`<PLUGIN>/pnpm-workspace.yaml` 里的 `onlyBuiltDependencies` 就是给这一步用的。）
之后 `node_modules/dsh-sinecause` 会指向插件目录，改完重启即可。

所有装法都要求包在 `package.json` 里声明了 `dsh.bundle`——本包已经声明：

```json
"dsh": { "bundle": { "patch": ["./cordis.patch.yml"] } }
```

装完确认：

```powershell
Get-Content <DSH_HOME>\profiles\web\package.json
# dependencies 里有 dsh-sinecause
# dsh.profile.bundles 里也有 dsh-sinecause
```

`dsh plugin add` 会在安装成功后把包名**追加到 `dsh.profile.bundles`**。

> **例外，踩过一次：** 如果上一次安装失败但 `package.json` 里已经留下了这条依赖，
> 重跑 `add` 会认为它"不是新装的"，于是**跳过 bundle 登记**——装是装上了，却不会被加载。
> 症状是 `--dump-config` 里看不到那三行。修法：先把 `dependencies` 里的
> `dsh-sinecause` 删掉再重跑，或者手工把包名加进 `dsh.profile.bundles`。

### 5.4 如果 npm registry 不可用

在 `<DSH_HOME>\profiles\web\.npmrc` 里加一行镜像：

```ini
registry=https://registry.npmmirror.com/
```

再重跑 5.2。

---

## 6. 准备向量模型

插件需要 `Xenova/bge-base-zh-v1.5` 的 ONNX 副本（int8 约 98MB）。

**源码装法：**

```powershell
cd <PLUGIN>
pwsh -File scripts/download-model.ps1
```

它会从 `hf-mirror.com` 下载四个文件到 `models/bge-base-zh-v1.5/`。

**npm 装法：** 脚本在包内，路径是
`<DSH_HOME>\profiles\web\node_modules\dsh-sinecause\scripts\download-model.ps1`（0.1.1 起才随包发布）。
但写进 `node_modules` 的模型可能被下一次安装清掉——更稳的是下载到别处，
再配 `config.embedding.modelPath` 指过去。

**不装也行：** 插件启动时优先用本地 `models/` 目录，没有就回落到 HF Hub（端点指向镜像），
第一次用向量时现下。慢，但能跑。

想跳过向量（只跑 goal + clock），把那两行的 `config.embedding` 设为 `{ enabled: false }`。
功能仍在，只是新旧判断退回词法，认不出"同一个能力换了说法"。

---

## 7. 验证

启动 DSH，按顺序验：

```powershell
# 1. 三个插件行都在组合后的配置里
dsh --profile web --dump-config | Select-String 'sinecause-goal|sinecause-memory|sinecause-clock'

# 2. 端口没被旧实例占着（重启前检查）
Get-NetTCPConnection -LocalPort 3080 -State Listen
```

然后在**这个工作区**新开一个会话，确认：

| 检查 | 期望 |
|---|---|
| 工具列表 | 有 `plan` 和 `memory` |
| 上下文末尾 | 出现 `## 目标与计划`，内容为"当前没有目标" |
| 写一条记忆 | `state/memory.json` 里该条 `embedding` 长度为 **768** |
| 攒够 12 条见闻 | 尾部多出 `### 该整理了` |
| 静置 `intervalMinutes` | 会话自己起一轮，内容以 `[心跳]` 开头 |

再开一个**工作区之外**的会话，确认它**没有** `plan` / `memory` 工具——
这是隔离生效的证据。

---

## 8. 已知的坑

这一节全是踩出来的，按踩到的顺序排。

| 现象 | 原因 | 处理 |
|---|---|---|
| 插件加载了，但一个会话都没生效 | 配置写 `C:/...`、cwd 是 `C:\...`，字面量前缀比较永不相等 | 本版已在 `workspace-gate.js` 里 normalize；自己改过的话别退回字面量比较 |
| `dsh plugin add` 报 `ERR_PNPM_IGNORED_BUILDS` 退出 1 | pnpm 默认不跑 onnxruntime/protobufjs 的安装脚本 | 命令加 `--allow-build=onnxruntime-node --allow-build=protobufjs` |
| 装完之后 `--dump-config` 里没有这三行 | 上一次失败的安装把依赖留在了 manifest，重跑时被当成"不是新装的"，跳过 bundle 登记 | 删掉 `dependencies` 里那条再重装，或手工补进 `dsh.profile.bundles` |
| 装了插件后应用起不来，日志 `EADDRINUSE` | 旧实例没退干净，端口被占 | 启动前确认 `Get-NetTCPConnection -LocalPort 3080` 无输出 |
| 装完 `plan`/`memory` 都不见了，启动只多一句 `3 entries did not activate` | 从 npm 装的包在 `node_modules` 里，没配 `workspaceRoot` | 按第 4 节在 profile 的 `cordis.patch.yml` 里按 id 覆盖，或设 `SINECAUSE_WORKSPACE` |
| 首次启动等了几分钟没有任何输出，像是卡死 | 启动期间不打印进度，URL 在最后一行才出 | 等；判断"卡住"之前先确认自己真的在等（`job_output` 不带 `wait` 会立刻返回） |
| 重启后插件又没了 | 把**插入行**写进了 profile 自己的 `cordis.patch.yml`，该文件会被插件安装重写 | 按 id **覆盖** config 是安全的；要新增行就用 bundle 自带的 patch |
| 心跳不触发 | 用了 `agent.inbox.append()` | 必须用 `agent.followup()`：前者只入队，不触发 `wakeDriver()` |
| 每次写记忆都报三条"相近" | 库里的条目全长在同一语境，同领域不同事余弦就有 0.82–0.89 | 本版用三条判据（同类 + 共用关键词 + 分数过线）；阈值按尺度分开 |
| `npm install` 报 500 | `registry.npmjs.org` 不可用 | profile 的 `.npmrc` 加镜像 |
| 模型下载卡住 | `huggingface.co` 直连被污染；Node 不走系统代理 | 用第 6 步的脚本走 `hf-mirror.com` |
| `@fufan/dsh-plugin-llm-wiki` 之类报 cannot resolve | 是 profile 里列了但没装的 bundle | 只是 warning 并跳过，不影响启动 |

---

## 9. 升级与回滚

**只升级插件源码**（`link:` 安装）：改完重启 DSH 即可，不用重装。

**回滚整个插件**：从 `<DSH_HOME>\profiles\web\package.json` 的
`dsh.profile.bundles` 里删掉 `dsh-sinecause` 一行，重启。
包还在，只是不加载——比卸载安全。

**状态文件不会因为插件停用而损坏**，它们是纯 JSON。

---

## 10. 还没做完的部分

分发之前请明确这些边界：

- **整理仍是手动的。** 计数到阈值只会提醒，没有强制；她要自己调 `memory curate`。
- **`wait` 没实现。** 现在只有时钟单向叫醒，没有"主动断开本轮、等条件再醒"。
- **persona 没做。** 身份靠记忆里的 `self` 条目承载，没有开头的固定段落。
- **召回是词法不是向量。** 向量只用于条目之间的新旧判断；
  `systemPrompt.context()` 的 text 是同步函数，等不到模型。
- **只在 Windows 上验证过。** macOS / Linux 的路径与进程行为未测。
- **包名还叫 `dsh-sinecause`。** 它是从 goal 长出来的，名字没跟上范围；分发前应改成
  `dsh-sinecause` 之类。改名要同步：包名、`exports`、profile 依赖、`bundles`、文档。
- **没有多实例隔离。** 状态文件是绝对路径，一份工作区对应一份状态；两个工作区想要两个人格，
  就复制两份、各自配 workspaceRoot。

---

## 11. 从零到跑通：完整命令

**npm 装法**（部署推荐）：

```powershell
# 1. 工作区
cd <WORKSPACE>
git init

# 2. 退出 DSH 后安装（dsh 不在 PATH 上就用 pnpm dsh）
#    两个 --allow-build 不能省，否则 pnpm 以 ERR_PNPM_IGNORED_BUILDS 退出 1
dsh plugin --profile web add dsh-sinecause --allow-build=onnxruntime-node --allow-build=protobufjs

# 3. 配工作区（必须！包在 node_modules 里，默认解析指不到）
#    按第 4 节写 <DSH_HOME>/profiles/web/cordis.patch.yml 的三行 workspaceRoot

# 4. 启动
dsh web                                  # 或 pnpm dsh web

# 5. 验证
dsh --profile web --dump-config | Select-String 'sinecause'
```

**源码装法**（零配置，改代码用）：

```powershell
cd <WORKSPACE>; git init
cd <PLUGIN>
pwsh -File scripts/download-model.ps1          # 可选：本地模型副本
pnpm install --registry https://registry.npmmirror.com/
cd <WORKSPACE>
dsh plugin --profile web add link:<PLUGIN> --allow-build=onnxruntime-node --allow-build=protobufjs
dsh web
```

装好之后第一次用向量会加载模型，约 600ms；之后常驻。

装好之后第一次写记忆会加载模型，约 600ms；之后常驻。
