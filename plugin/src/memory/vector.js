/**
 * 向量的纯函数部分：文本拼装、指纹、余弦、新鲜度判断。
 *
 * 单独一层是为了可测且不拖入 ONNX——`embedding.js` 才需要 transformers。
 */

import { createHash } from 'node:crypto'

/** 默认模型：bge-base-zh-v1.5，768 维，C-MTEB 检索 69.49。 */
export const DEFAULT_MODEL = 'Xenova/bge-base-zh-v1.5'

/** 向量格式版本；改分词/拼装方式时要一起升。 */
export const EMBEDDING_VERSION = 1

/** bge 系列的查询指令前缀，只加在 query 上。 */
export const DEFAULT_QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'

/** 本机可直连的镜像源。 */
export const DEFAULT_ENDPOINT = 'https://hf-mirror.com/'

/** bge 官方 recipe 用 CLS 池化；mean 作为对照项保留。 */
export const DEFAULT_POOLING = 'cls'

/** 参与向量化的文字：和词法相似度用同一份，便于对照。 */
export function embeddingText(entry) {
  return [entry.title, entry.summary, ...(entry.keywords ?? [])].filter(Boolean).join('\n')
}

/** 内容指纹；对不上就说明该重算了。 */
export function embeddingHash(entry) {
  return createHash('sha1').update(embeddingText(entry), 'utf8').digest('hex')
}

/** 两条向量是否可比：长度一致且非空。 */
function comparable(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.length > 0
}

/** 余弦相似度；向量已归一化时就是点积。 */
export function cosine(left, right) {
  if (!comparable(left, right)) return 0
  let dot = 0
  for (let index = 0; index < left.length; index += 1) dot += left[index] * right[index]
  return dot
}

/**
 * 一条记忆的实际相似度：有向量用向量，缺就退回词法。
 * @param {object} left
 * @param {object} right
 * @param {(a: object, b: object) => number} fallback - 词法相似度。
 * @returns {number} 0 到 1。
 */
export function entrySimilarity(left, right, fallback) {
  if (comparable(left.embedding, right.embedding)) return cosine(left.embedding, right.embedding)
  return fallback(left, right)
}

/** 一条记忆的向量是否还能用。 */
export function embeddingFresh(entry, model) {
  return Array.isArray(entry.embedding)
    && entry.embedding.length > 0
    && entry.embeddingModel === model
    && entry.embeddingVersion === EMBEDDING_VERSION
    && entry.embeddingHash === embeddingHash(entry)
}
