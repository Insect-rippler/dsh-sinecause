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

最短路径（npm 安装）：

```powershell
# 1. 工作区自成一个项目根
cd <WORKSPACE>; git init

# 2. 完全退出 DSH 后装插件
dsh plugin --profile web add dsh-sinecause --allow-build=onnxruntime-node --allow-build=protobufjs

# 3. 告诉它工作区在哪（npm 安装必须做，见下）
#    编辑 <DSH_HOME>/profiles/web/cordis.patch.yml
```

```yaml
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

**为什么第 3 步不能省：** 工作区默认取"包的上一级目录"——从 npm 装时那是
`node_modules`，插件会在加载时直接报错，而不是把状态文件写进依赖目录。
也可以不改文件，改成启动前设 `SINECAUSE_WORKSPACE=<WORKSPACE>`。

**想零配置**就用 git 检出 + `link:` 安装：包就在 `<WORKSPACE>/plugin`，"上一级目录"正好是工作区。

**向量模型**首次使用会自动从 `hf-mirror.com` 下载（约 98MB，慢）。想用现成的本地副本，
配 `embedding.modelPath` 指到模型目录即可。

## 目录

```
plugin/            Cordis 插件包（goal + memory + clock）
  src/index.js           目标：尾部注入 + plan 工具
  src/memory/            记忆库：常驻档案、向量相似、整理
  src/clock/             心跳：按间隔醒来
  src/paths.js           工作区与状态文件的默认解析
  src/workspace-gate.js  工作区判定（三个插件共用）
  test/                  139 个用例：node --test
docs/deploy.md     部署教程
.github/workflows/publish.yml   发布：推 tag 即发（OIDC，无需 token）
```

## 发布

发版不需要 token，也不需要人在现场：

```sh
# 1. 改 plugin/package.json 的版本号，写 CHANGELOG
# 2. 推 tag
git tag -a v0.1.3 -m "…" && git push origin v0.1.3
```

GitHub Actions 会跑测试、然后 `npm publish --provenance`。认证走 [OIDC 可信发布](https://docs.npmjs.com/trusted-publishers)——
npm 认的是"哪个仓库的哪个 workflow"，不是一把长期密钥。

一次性配置在 npm 的包设置页：Trusted Publisher 填 `Insect-rippler/dsh-sinecause` + `publish.yml`。

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
