/**
 * 向量模型验收：用真实例子对比 cls / mean 两种池化。
 *
 *   node scripts/check-embedding.mjs [model] [dtype]
 *
 * 默认 Xenova/bge-base-zh-v1.5 + int8（fp32 约 430MB，int8 约 110MB）。
 * 第一次运行会从 huggingface.co 下载并缓存。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { env, pipeline } from '@huggingface/transformers'

const MODEL = process.argv[2] ?? 'Xenova/bge-base-zh-v1.5'
const DTYPE = process.argv[3] ?? 'int8'
// 本机 huggingface.co 直连被污染，Node 不走系统代理；hf-mirror 可直连。
// 想换回官方源就设 HF_ENDPOINT=https://huggingface.co/
env.remoteHost = process.env.HF_ENDPOINT ?? 'https://hf-mirror.com/'
// 有本地副本（scripts/download-model.ps1 下的）就优先用，离线也能跑。
const LOCAL = fileURLToPath(new URL('../models/bge-base-zh-v1.5', import.meta.url))
const SOURCE = existsSync(LOCAL) ? LOCAL : MODEL
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'

/** 文档之间：同一个能力换了说法，词法判为 0，向量应该认出来。 */
const DOCS = [
  '无头浏览器：用 playwright-core 控制 chromium 抓页面',
  '浏览器自动化：puppeteer 起一个 headless chrome',
  '他 3 月 12 日生日',
  '生日礼物准备：提前一周买好',
]

/** 查询：应当命中文档 0 和 1。 */
const QUERY = '网页自动化工具'

function cosine(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return dot
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

console.log(`model=${SOURCE} dtype=${DTYPE}`)
const started = Date.now()
const extractor = await pipeline('feature-extraction', SOURCE, { dtype: DTYPE })
console.log(`loaded in ${Date.now() - started}ms`)

for (const pooling of ['cls', 'mean']) {
  const begin = Date.now()
  const docs = await extractor(DOCS, { pooling, normalize: true })
  const docVectors = docs.tolist()
  const queryVector = (await extractor([QUERY_PREFIX + QUERY], { pooling, normalize: true })).tolist()[0]
  const elapsed = Date.now() - begin

  console.log(`\n== pooling=${pooling} (${DOCS.length + 1} 条 / ${elapsed}ms) ==`)
  console.log(`  文档相似度：0↔1 ${round(cosine(docVectors[0], docVectors[1]))}`
    + ` · 0↔2 ${round(cosine(docVectors[0], docVectors[2]))}`
    + ` · 2↔3 ${round(cosine(docVectors[2], docVectors[3]))}`)
  console.log('  查询命中：')
  for (const [index, vector] of docVectors.entries()) {
    console.log(`    ${round(cosine(queryVector, vector))}  ${DOCS[index].slice(0, 28)}`)
  }
}
