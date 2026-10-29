/**
 * 一致性检查：新包 vs dsh-self-evolution 里原有的启发式实现。
 *
 * 原实现靠在压缩数据里扫描魔数、逐个尝试解压，重复解码 + 可能命中假魔数；
 * 新包按 RFC 8878 的帧边界精确切分。两者的解码结果必须一致。
 *
 * 用法: node scripts/parity-check.mjs [dsh-self-evolution 仓库路径]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { decodeText } from '../src/index.js'

const repo = resolve(process.argv[2] ?? 'C:/Users/foxing/dsh-self-evolution')
const sessionRoot = join(homedir(), '.dsh', 'sessions')

const { readEvents } = await import(pathToFileURL(join(repo, 'packages', 'sessionlog', 'index.mjs')).href)

function collect(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) collect(p, out)
    else if (ent.name.endsWith('.jsonl.zstd')) out.push(p)
  }
  return out
}

if (!statSync(sessionRoot, { throwIfNoEntry: false })) {
  console.log('找不到会话目录，跳过:', sessionRoot)
  process.exit(0)
}

const files = collect(sessionRoot)
let checked = 0
let mismatch = 0

for (const file of files) {
  const oldEvents = readEvents(file)
  const text = decodeText(readFileSync(file))
  const newEvents = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { newEvents.push(JSON.parse(line)) } catch { /* 半行忽略，与旧实现一致 */ }
  }
  const oldJson = JSON.stringify(oldEvents)
  const newJson = JSON.stringify(newEvents)
  const same = oldJson === newJson
  if (!same) mismatch++
  checked++
  console.log(
    `${same ? 'OK  ' : 'DIFF'}  旧 ${String(oldEvents.length).padStart(5)} 事件 / 新 ${String(newEvents.length).padStart(5)} 事件  ${file}`
  )
}

console.log(`\n共检查 ${checked} 个会话文件，不一致 ${mismatch} 个`)
process.exit(mismatch === 0 ? 0 : 1)