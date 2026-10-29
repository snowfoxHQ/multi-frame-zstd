import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import {
  ZstdError,
  ZSTD_MAGIC_BYTES,
  decodeConcat,
  decodeFrames,
  decodeText,
  frameCount,
  isZstd,
  scanFrames
} from '../src/index.js'

const frame = (text) => zstdCompressSync(Buffer.from(text, 'utf8'))
const frames = (...texts) => Buffer.concat(texts.map(frame))

test('单帧：解出内容', () => {
  const out = decodeFrames(frame('hello'))
  assert.equal(out.length, 1)
  assert.equal(out[0].toString('utf8'), 'hello')
})

test('多帧：逐帧解出且顺序正确（Node 内置只解第一帧，这里必须全解）', () => {
  const buf = frames('AAA', 'BBB', 'CCC')
  const out = decodeFrames(buf)
  assert.equal(out.length, 3)
  assert.deepEqual(out.map((b) => b.toString('utf8')), ['AAA', 'BBB', 'CCC'])
})

test('decodeConcat 把所有帧拼起来', () => {
  const buf = frames('AAA', 'BBB')
  assert.equal(decodeConcat(buf).toString('utf8'), 'AAABBB')
  assert.equal(decodeText(buf), 'AAABBB')
})

test('空输入：没有帧，也没有内容', () => {
  assert.deepEqual(decodeFrames(Buffer.alloc(0)), [])
  assert.equal(decodeConcat(Buffer.alloc(0)).length, 0)
  assert.equal(isZstd(Buffer.alloc(0)), false)
})

test('isZstd 只看开头魔数', () => {
  assert.equal(isZstd(frame('x')), true)
  assert.equal(isZstd(Buffer.from('not zstd at all')), false)
})

test('非 zstd 数据：strict 抛错并说明偏移', () => {
  assert.throws(() => decodeFrames(Buffer.from('plain text, not zstd')), (err) => {
    assert.ok(err instanceof ZstdError)
    assert.match(err.message, /不是 zstd 帧/)
    return true
  })
})

test('被截断的帧：strict 抛错，宽松模式保留此前解出的帧', () => {
  const full = frames('AAA', 'BBB')
  const cut = full.subarray(0, full.length - 5)
  assert.throws(() => decodeFrames(cut), ZstdError)
  // 第一帧完整、第二帧被截断 → 宽松模式应当交出第一帧
  assert.deepEqual(decodeFrames(cut, { strict: false }).map((b) => b.toString()), ['AAA'])
})

test('第一帧就被截断：宽松模式也没有任何帧', () => {
  const one = frame('AAA')
  const cut = one.subarray(0, one.length - 5)
  assert.throws(() => decodeFrames(cut), ZstdError)
  assert.deepEqual(decodeFrames(cut, { strict: false }), [])
})

test('尾部有垃圾：strict 抛错，宽松模式保留已解出的帧', () => {
  const buf = Buffer.concat([frames('AAA', 'BBB'), Buffer.from('TRAILING-GARBAGE')])
  assert.throws(() => decodeFrames(buf), ZstdError)
  assert.deepEqual(decodeFrames(buf, { strict: false }).map((b) => b.toString()), ['AAA', 'BBB'])
})

test('可跳过帧被跳过，两侧的真帧照常解出', () => {
  const skippable = Buffer.alloc(8 + 5)
  skippable.writeUInt32LE(0x184d2a50, 0)
  skippable.writeUInt32LE(5, 4)
  skippable.write('hello', 8, 'utf8')
  const buf = Buffer.concat([frame('AAA'), skippable, frame('BBB')])
  const out = decodeFrames(buf)
  assert.deepEqual(out.map((b) => b.toString('utf8')), ['AAA', 'BBB'])
})

test('载荷里含魔数字节：照常解出（按魔数瞎扫的启发式在这里会出错）', () => {
  const tricky = `prefix${ZSTD_MAGIC_BYTES.toString('latin1')}suffix`
  const out = decodeFrames(frame(tricky))
  assert.equal(out[0].toString('utf8'), tricky)
})

test('大载荷往返正确', () => {
  const big = 'x'.repeat(512 * 1024)
  const out = decodeFrames(frame(big))
  assert.equal(out.length, 1)
  assert.equal(out[0].length, big.length)
})

test('scanFrames 报告边界，长度之和等于输入长度', () => {
  const buf = frames('AAA', 'BBBBB', 'C')
  const list = scanFrames(buf)
  assert.equal(list.length, 3)
  assert.equal(list[0].offset, 0)
  assert.deepEqual(list.map((f) => f.length), [frame('AAA').length, frame('BBBBB').length, frame('C').length])
  const total = list.reduce((sum, f) => sum + f.length, 0)
  assert.equal(total, buf.length)
  assert.equal(frameCount(buf), 3)
})

test('真实 dsh 会话日志（存在才跑）：能解出事件行', () => {
  const root = join(homedir(), '.dsh', 'sessions')
  if (!existsSync(root)) return
  const files = []
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.name.endsWith('.jsonl.zstd')) files.push(p)
    }
  }
  walk(root)
  if (files.length === 0) return
  const text = decodeText(readFileSync(files[0]))
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  assert.ok(lines.length > 0, `期望 ${files[0]} 至少解出一行`)
  JSON.parse(lines[0])
})