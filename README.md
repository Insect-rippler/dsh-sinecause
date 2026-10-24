# dsh-sinecause

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上给一个会话装上
**自己的目标、记忆和作息**。三个 Cordis 插件，一个 bundle。

> **状态：alpha。** 能部署、能用，但边界很清楚——见 [限制](#限制)。

## 它做什么

| 入口 | 作用 |
|---|---|
| `dsh-sinecause` | 目标与计划。Agent 自己立 plan、分步推进；内容注入在**上下文末尾**，持续把注意力拉回当前步骤 |
| `dsh-sinecause/memory` | 记忆库。常驻档案（`anchor`/`self`）每次请求都注入，流水（`skill`/`fact`/`episode`/`promise`）按相似度召回 |
| `dsh-sinecause/clock` | 时钟。没人说话时按间隔叫醒它，让它自己找事做 |

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

完整步骤见 **[docs/deploy.md](docs/deploy.md)**：前置条件、安装、模型准备、
验收清单和十条踩过的坑。

最短路径（`link:` 装法，零配置）：

```powershell
# 1. 工作区自成一个项目根，插件包放在 <WORKSPACE>/plugin
cd <WORKSPACE>; git init

# 2. 下载向量模型（约 98MB，走 hf-mirror）
cd plugin; pwsh -File scripts/download-model.ps1

# 3. 装进插件目录自己的 node_modules（link: 不会替你装依赖）
pnpm install --registry https://registry.npmmirror.com

# 4. 完全退出 DSH 后安装
cd <WORKSPACE>
dsh plugin --profile web add link:<WORKSPACE>/plugin --allow-build=onnxruntime-node --allow-build=protobufjs
```

**用 `file:` 装法的话要多做一步**：包会被复制进 profile 的 `node_modules`，
"默认取包的上一级目录"就指错了，必须在 `plugin/cordis.patch.yml` 里显式写
`workspaceRoot`，或者设环境变量 `SINECAUSE_WORKSPACE`。
不写的话插件会在加载时直接报错，而不是把状态文件写进依赖目录。

## 目录

```
plugin/            Cordis 插件包（goal + memory + clock）
  src/index.js           目标：尾部注入 + plan 工具
  src/memory/            记忆库：常驻档案、向量相似、整理
  src/clock/             心跳：按间隔醒来
  src/paths.js           工作区与状态文件的默认解析
  src/workspace-gate.js  工作区判定（三个插件共用）
  test/                  130 个用例：node --test
docs/deploy.md     部署教程
```

## 限制

分发前请明确这些边界，别当成完成品：

- **整理仍是手动的。** 攒够见闻只提醒，不强制整理。
- **没有 `wait`。** 只有时钟单向叫醒，没有"主动断开本轮、等条件再醒"。
- **没有 persona。** 身份靠记忆里的 `self` 条目承载。
- **召回是词法，不是向量。** 向量只用在条目之间的新旧判断上。
- **只在 Windows 上验证过。**

## 测试

```sh
cd plugin && node --test
```

## 许可

[MIT](LICENSE)
