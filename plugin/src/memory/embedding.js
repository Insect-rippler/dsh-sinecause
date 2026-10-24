/**
 * 向量：bge-base-zh-v1.5（768 维）的进程内实现。
 *
 * 用在哪：**条目与条目之间的相似度**——判断"同一件事是不是又有了新情况"。
 * 不用在哪：召回。`systemPrompt.context()` 的 text 是同步函数，没法等模型；
 * 要拿向量做召回，得在 pre-step 异步算好查询向量再缓存，那是下一步的事。
 *
 * 模型由 transformers.js 加载 ONNX，第一次跑会下载并缓存（int8 约 110MB）。
 * 本机 huggingface.co 直连不可用，默认走 hf-mirror；换回官方源设 `endpoint`。
 * 纯函数部分在 `vector.js`，这里只管加载与批量计算。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_POOLING,
  DEFAULT_QUERY_PREFIX,
  EMBEDDING_VERSION,
  embeddingFresh,
  embeddingHash,
  embeddingText,
} from './vector.js'

export * from './vector.js'

/** 随包下载的本地模型目录；存在就直接用，不走网络。 */
export const LOCAL_MODEL_DIR = fileURLToPath(new URL('../../models/bge-base-zh-v1.5', import.meta.url))

/** 向量按 5 位小数存，压缩 JSON 体积。 */
function round(vector) {
  return vector.map(value => Math.round(value * 1e5) / 1e5)
}

/**
 * 建一个 embedding 执行器。首次调用才加载模型，之后常驻。
 * @param {{ model?: string, modelPath?: string, dtype?: string, pooling?: string, endpoint?: string, queryPrefix?: string }} [config]
 * @returns {{ model: string, pooling: string, embed: (texts: string[], options?: { query?: boolean }) => Promise<number[][]>, embedEntry: (entry: object) => Promise<number[]> }}
 */
export function createEmbedder(config = {}) {
  const model = config.model ?? DEFAULT_MODEL
  const dtype = config.dtype ?? 'int8'
  const pooling = config.pooling ?? DEFAULT_POOLING
  const queryPrefix = config.queryPrefix ?? DEFAULT_QUERY_PREFIX
  // 有本地副本就当离线模型用：Windows 上 huggingface.co 直连不可用，
  // 走镜像也就 ~100KB/s，110MB 要十几分钟。本地目录没有才回落到远端。
  const local = config.modelPath
    ?? (existsSync(LOCAL_MODEL_DIR) ? LOCAL_MODEL_DIR : undefined)
  const endpoint = config.endpoint ?? process.env.HF_ENDPOINT ?? DEFAULT_ENDPOINT

  // 动态加载：transformers + onnxruntime 加起来约 600ms，不该让所有会话在
  // 启动时都背这个开销——只有真的要算向量时才拉进来。
  let loading
  const load = () => {
    loading ??= import('@huggingface/transformers').then(({ env, pipeline }) => {
      env.remoteHost = endpoint
      return pipeline('feature-extraction', local ?? model, { dtype })
    })
    return loading
  }

  const embed = async (texts, options = {}) => {
    if (texts.length === 0) return []
    const extractor = await load()
    const prepared = options.query === true ? texts.map(text => queryPrefix + text) : texts
    const output = await extractor(prepared, { pooling, normalize: true })
    return output.tolist()
  }

  return {
    model,
    pooling,
    embed,
    async embedEntry(entry) {
      const [vector] = await embed([embeddingText(entry)])
      return vector ?? []
    },
  }
}

/**
 * 给一条记忆算向量字段（不落盘，调用方负责保存）。
 * @param {object} entry
 * @param {ReturnType<typeof createEmbedder>} embedder
 * @returns {Promise<object>} embedding / embeddingModel / embeddingVersion / embeddingHash。
 */
export async function embeddingFields(entry, embedder) {
  const vector = await embedder.embedEntry(entry)
  return {
    embedding: round(vector),
    embeddingModel: embedder.model,
    embeddingVersion: EMBEDDING_VERSION,
    embeddingHash: embeddingHash(entry),
  }
}

/**
 * 批量补齐缺失或过期的向量，返回补过的条目数。
 * 一次算完再一次落盘——逐条 update 会把整个 JSON 重写 N 遍。
 * @param {import('./store.js').MemoryStore} store
 * @param {ReturnType<typeof createEmbedder>} embedder
 * @param {{ limit?: number }} [options]
 */
export async function backfillEmbeddings(store, embedder, options = {}) {
  const limit = options.limit ?? 64
  const all = store.all()
  const stale = all
    .filter(entry => !embeddingFresh(entry, embedder.model))
    .slice(0, limit)
  if (stale.length === 0) return 0
  const vectors = await embedder.embed(stale.map(entry => embeddingText(entry)))
  const fresh = new Map(stale.map((entry, index) => [entry.id, {
    embedding: round(vectors[index] ?? []),
    embeddingModel: embedder.model,
    embeddingVersion: EMBEDDING_VERSION,
    embeddingHash: embeddingHash(entry),
  }]))
  store.save(all.map(entry => (fresh.has(entry.id) ? { ...entry, ...fresh.get(entry.id) } : entry)))
  return stale.length
}
