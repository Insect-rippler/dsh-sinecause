# 变更记录

## 0.1.1 — 未发布

### 修复

- **改正文后摘要不重算。** `update({ content })` 不带 `summary` 时，摘要保留旧值：
  召回块渲染的是 `title：summary`，于是她会读到旧内容；更糟的是 `embeddingHash`
  由 title+summary+keywords 组成，摘要不动它就继续匹配，旧向量永远不会被判过期重算。
  现在正文变而摘要未给时自动重算。
- **召回几乎捞不出东西。** `lexicalScore` 只用关键词/标签/实体做"查询包含关键词"的精确判断，
  **标题完全不参与打分**，中文又没有空格——实测 10 条库、一句正常提问只召回 1 条。
  现在标题与关键词按双字重合给部分分（最多 2 分，半个关键词命中的分量）。
- **低位真匹配被丢弃。** `sameSubjectEntries` 先按分数截断 12 条再过滤，
  库里条目一多，真正的同类条目只要原始分数排在第 12 名之后就会被丢掉。改成全量过滤后截断。

### 打包

- `scripts/` 进入 `files`：从 npm 安装也能拿到 `download-model.ps1`（离线下载向量模型）
  和 `check-embedding.mjs`（池化与相似度验收）。
- **`LICENSE` 进包根。** 之前许可证文件只在仓库根，npm 包里没有，registry 页面上显示"无许可证文件"。
- **忘了配 `workspaceRoot` 的报错改写。** 原文案只说"用 `file:` 装法时"，但从 npm 装的包
  同样在 `node_modules` 里，是同一个坑；现在把两种装法都写清楚，并点名 `link:` 不需要配。

## 0.1.0 — 2026-10-24

首个发布版本。

- **goal**：`plan` 工具（create / list / done / block / add / timer / finish / abandon）；
  目标与计划注入在上下文**末尾**，内容不变不重发，变了替换旧快照。
- **memory**：常驻档案（`anchor` / `self`）每次请求注入，流水（`skill` / `fact` /
  `episode` / `promise`）按分数召回；新旧判断用 bge-base-zh-v1.5（768 维）向量，
  过时有两个去处（`supersede` 让位、`expire` 降权）；整理由计数触发。
- **clock**：空闲时按间隔叫醒，只叫最近活跃的工作区会话，子代理不叫。
- 工作区隔离：三个插件都只对 cwd 落在 `workspaceRoot` 下的会话生效。
- 已知限制见仓库 README 的「限制」一节。
