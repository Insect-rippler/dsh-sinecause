# dsh-sinecause

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上给一个会话装上
**自己的目标、记忆和作息**。三个 Cordis 插件，一个 bundle。

> **状态：alpha。** 能部署、能用，但边界很清楚——见 [限制](#限制)。

## 它做什么

| 入口 | 作用 |
|---|---|
| `dsh-goal-agenda` | 目标与计划。Agent 自己立 plan、分步推进；内容注入在**上下文末尾**，持续把注意力拉回当前步骤 |
| `dsh-goal-agenda/memory` | 记忆库。常驻档案（`anchor`/`self`）每次请求都注入，流水（`skill`/`fact`/`episode`/`promise`）按相似度召回 |
| `dsh-goal-agenda/clock` | 时钟。没人说话时按间隔叫醒它，让它自己找事做 |

三者都只对 cwd 落在 `workspaceRoot` 下的会话生效——装进共享 profile 不会影响其它工作区的会话。

## 三个设计取舍

**1. 目标放在上下文末尾，不是开头。**
开头是「我是谁」（persona），末尾才是「此刻做什么」。放错位置，目标就退化成普通指令，
失去逐轮引导注意力的作用。

**2. 记忆分两层：档案与流水。**
`self` / `anchor` 每次请求都注入（所以必须短）；其余只在相关时召回。
"记住自己"靠前者，"记住发生过什么"靠后者。

**3. 过时是一个判断、两个去处。**
同一件事有了新情况，看新旧之间有没有连续性：没有连续性（换掉了）就 `supersede` 让位；
有连续性（同一件事在时间上继续）就 `expire` 降权——它仍然成立，只是不再适用于当下。
只有错误的判断才 `delete`。

## 快速开始

完整步骤见 **[docs/deploy.md](docs/deploy.md)**，包括前置条件、改路径、安装、
模型准备、验收清单和十条踩过的坑。

最短路径：

```powershell
# 1. 工作区自成一个项目根
cd <WORKSPACE>; git init

# 2. 改 plugin/cordis.patch.yml 里的三处绝对路径

# 3. 下载向量模型（约 98MB，走 hf-mirror）
cd plugin; pwsh -File scripts/download-model.ps1

# 4. 完全退出 DSH 后安装
dsh plugin --profile web add file:<PLUGIN> --allow-build=onnxruntime-node --allow-build=protobufjs
```

## 目录

```
plugin/            Cordis 插件包（goal + memory + clock）
  src/goal         目标与计划的尾部注入 + plan 工具
  src/memory       记忆库：常驻档案、向量相似、整理
  src/clock        心跳：按间隔醒来
  src/workspace-gate.js   工作区判定（两个插件共用）
  test/            121 个用例：node --test
docs/deploy.md     部署教程
```

## 限制

分发前请明确这些边界，别当成完成品：

- **整理仍是手动的。** 攒够见闻只提醒，不强制整理。
- **没有 `wait`。** 只有时钟单向叫醒，没有"主动断开本轮、等条件再醒"。
- **没有 persona。** 身份靠记忆里的 `self` 条目承载。
- **召回是词法，不是向量。** 向量只用在条目之间的新旧判断上。
- **只在 Windows 上验证过。**
- **包名待改。** 包还叫 `dsh-goal-agenda`，范围已经超出 goal；改成 `dsh-sinecause` 需要同步
  `exports`、profile 依赖、bundles 与文档。
- **没有许可证文件。** 采用何种许可由仓库所有者决定。

## 测试

```sh
cd plugin && node --test
```

## 名字

仓库叫 sinecause，包还叫 dsh-goal-agenda——前者是产品，后者是从 goal 长出来的包名。
改名排在 1.0 之前。
