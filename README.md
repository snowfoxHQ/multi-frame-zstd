# multi-frame-zstd

解码多个 zstd 帧首尾相接的数据。零 npm 依赖，纯 JS 帧解析，解压交给 Node 内置 `node:zlib`。

> **前提**：Node >= 23.8（内置 zstd 是硬前提），ESM only。CommonJS 用 `await import()`。

Decode concatenated zstd frames. Frame parsing is pure JS with zero npm
dependencies; decompression is delegated to Node's built-in `node:zlib`.

```bash
npm install multi-frame-zstd

为什么需要它

Node 内置的 zlib.zstdDecompressSync() 在一次性解压时只解第一帧：
js

import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
const buf = Buffer.concat([
  zstdCompressSync(Buffer.from('FIRST-FRAME')),
  zstdCompressSync(Buffer.from('SECOND-FRAME'))
])
zstdDecompressSync(buf).toString()   // → 'FIRST-FRAME'，第二帧没了

    行为随 API 和版本而异。下表是本包在 Node v24.18.0 上的实测，其他版本请自行验证：
    API	两帧拼接后的输出
    zstdDecompressSync()	只输出 FIRST-FRAME
    createZstdDecompress() 流式	只输出 FIRST-FRAME

    Node 官方文档对 ZstdDecompress 类写的是 "Concatenated Zstd and skippable
    frames are decoded as a single stream"，但在本包实测的 v24.18.0 上，流式便捷
    API 并未跨帧解码。这正是我们选择按 RFC 8878 自己扫帧边界、而不是依赖内置
    API 的根本原因：行为需要可预期，不能赌版本。

    如果你在别的版本上测到不同行为，欢迎提 issue 补充版本矩阵。

为什么不直接用流式 API

在本包实测的 Node v24.18.0 上，createZstdDecompress() 和
zstdDecompressSync() 一样只解第一帧，所以它解决不了本包要解决的问题。
即便某些版本能跨帧，流式 API 也：(1) 行为随版本变化，不可依赖；(2) 做
"扫描帧边界、只解某几帧、报告每帧偏移"不顺手；(3) 遇到损坏帧时错误定位
不如逐帧解析精确。
真实场景

很多系统是每次 flush 追加一个独立帧。一个真实案例是 DeepSeek Harness 的
session.v4.jsonl.zstd——每次 flush 追加一帧（实测 10877B 共 6 帧，首帧仅 187B）。

任何"按 flush 追加独立帧"的日志格式都会遇到同样的问题。不按帧边界逐帧解码，
就只能读到 header —— 在日志场景里会被误判成"这个文件里没有数据"。

不适用：ClickHouse 的列级 codec、RocksDB WAL、Kafka RecordBatch 虽然也用
zstd，但压缩单元嵌在各自的记录框架里，不是纯连续 zstd 帧拼接，本包不适用。
用法
js

import { decodeConcat, decodeFrames, decodeText } from 'multi-frame-zstd'
import { readFileSync } from 'node:fs'

// 拼成一个 Buffer
const text = decodeText(readFileSync('session.v4.jsonl.zstd'))

for (const line of text.split('\n')) {
  if (line.trim()) JSON.parse(line)
}

// 或者逐帧拿
const frames = decodeFrames(readFileSync('session.v4.jsonl.zstd'))
console.log(frames.length, '帧')

API
函数	说明
decodeFrames(input, opts?)	→ Buffer[]，每帧解压后的内容，顺序与输入一致
decodeConcat(input, opts?)	→ Buffer，所有帧内容拼接
decodeText(input, opts?)	→ string，同上再转文本（opts.encoding 默认 utf8）
scanFrames(input, opts?)	→ 帧边界描述 { offset, length, contentSize, dictionaryId }[]，不解压
frameCount(input, opts?)	帧数量，只扫边界不解压
isZstd(input)	缓冲区是否以 zstd 帧开头
ZstdError	所有错误都是这个类，带偏移信息
选项
js

decodeFrames(buf, { strict: false })

    strict: true（默认）：遇到截断、垃圾数据、非法块类型立刻抛 ZstdError，错误信息带字节偏移。

    strict: false：遇到坏数据就停，返回此前已成功解出的帧。适合"尽力而为"地读日志。

其它行为

    可跳过帧（RFC 8878 §3.1.2，魔数 0x184D2A50–0x184D2A5F）自动跳过。

    依赖字典的帧会抛明确错误（报出字典 ID），而不是给出一个看不懂的解压失败。

    带内容校验和的帧正常支持。

边界与不承诺

    不提供从结构不完整的截断帧里恢复部分明文的能力——strict: false 只是丢弃
    坏帧、保留前面的完整帧。需要"从半截帧抢救明文"请用
    @hy-sde-org/dsh-zstd-frame 的 decompressZstdPrefix。

    不适用于嵌入记录框架的格式（ClickHouse 列块、RocksDB WAL、Kafka RecordBatch）。

和现有方案的区别

生态里已经有支持多帧的解码器，比如 zstdify（concatenated + skippable frames）、
zstd-js（流式遍历整个 stream）。本包的差异不在"能不能解多帧"，而在：

    零 npm 依赖、无 WASM、无原生绑定：帧结构用纯 JS 解析，解压交给 Node 内置
    node:zlib，不引入任何第三方运行时。

    容错策略显式可选：strict: true 带字节偏移报错；strict: false 尽力而为。

    小 API 面：decodeFrames / decodeConcat / decodeText / scanFrames /
    frameCount / isZstd，没有多余抽象。

兼容性

    Node >= 23.8（需要内置 node:zlib 的 zstd 支持；22.15+ 也有，本包在 23.8+ 上测试）。

    ESM only，CommonJS 用 await import()。

开发
bash

npm test          # 14 个用例
npm run parity    # 与 dsh-self-evolution 的旧实现逐个会话文件比对结果

npm run parity 会读本机 ~/.dsh/sessions 下的真实会话日志，
验证新包与原项目里的启发式实现解码结果完全一致（当前：30/30 一致）。
这组比对证明"没回退"，不证明"正确"——旧实现若有 bug 会被一并继承。
与外部实现（zstd CLI / zstdify）的交叉验证尚未纳入 npm run parity。
License

MIT