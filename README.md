# multi-frame-zstd

**解码多个 zstd 帧首尾相接的数据。零依赖，纯 JS。**

Decode concatenated zstd frames. Zero dependencies, pure JS, no native modules.

```bash
npm install multi-frame-zstd
```

## 为什么需要它

Node 内置的 `zlib.zstdDecompressSync()` 和 zstd 流**都只解第一帧**：

```js
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
const buf = Buffer.concat([
  zstdCompressSync(Buffer.from('FIRST-FRAME')),
  zstdCompressSync(Buffer.from('SECOND-FRAME'))
])
zstdDecompressSync(buf).toString()   // → 'FIRST-FRAME'   第二帧没了
```

而很多系统是**每次 flush 追加一个独立帧**：

| 系统 | 写法 |
|---|---|
| DeepSeek Harness | `session.v4.jsonl.zstd` 每次 flush 追加一帧（实测 10877B 共 6 帧，首帧仅 187B） |
| ClickHouse / RocksDB WAL / 部分 Kafka 实现 | 同样按帧追加 |

不按帧边界逐帧解码，就只能读到 header —— 在日志场景里会被误判成"这个文件里没有数据"。

生态里现成的解法都只支持单帧：`fzstd`、`zstd-codec`（WASM）、`@mongodb-js/zstd`（原生绑定）。
这个包自己按 **RFC 8878** 解析帧结构（帧头 + 块序列），切出每一帧的精确字节范围，
再交给 Node 内置的 zstd 解压器 —— 所以零依赖、零原生模块，也不需要重新实现 zstd。

## 用法

```js
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
```

## API

| 函数 | 说明 |
|---|---|
| `decodeFrames(input, opts?)` | → `Buffer[]`，每帧解压后的内容，顺序与输入一致 |
| `decodeConcat(input, opts?)` | → `Buffer`，所有帧内容拼接 |
| `decodeText(input, opts?)` | → `string`，同上再转文本（`opts.encoding` 默认 `utf8`） |
| `scanFrames(input, opts?)` | → 帧边界描述 `{ offset, length, contentSize, dictionaryId }[]`，**不解压** |
| `frameCount(input, opts?)` | 帧数量，只扫边界不解压 |
| `isZstd(input)` | 缓冲区是否以 zstd 帧开头 |
| `ZstdError` | 所有错误都是这个类，带偏移信息 |

### 选项

```js
decodeFrames(buf, { strict: false })
```

- `strict: true`（默认）：遇到截断、垃圾数据、非法块类型立刻抛 `ZstdError`，错误信息带字节偏移。
- `strict: false`：遇到坏数据就停，**返回此前已成功解出的帧**。适合"尽力而为"地读日志。

### 其它行为

- **可跳过帧**（RFC 8878 §3.1.2，魔数 `0x184D2A50`–`0x184D2A5F`）自动跳过。
- **依赖字典的帧**会抛明确错误（报出字典 ID），而不是给出一个看不懂的解压失败。
- **带内容校验和**的帧正常支持。

## 兼容性

- Node **>= 23.8**（需要内置 `node:zlib` 的 zstd 支持；22.15+ 也有，本包在 23.8+ 上测试）。
- ESM only，CommonJS 用 `await import()`。

## 开发

```bash
npm test          # 14 个用例
npm run parity    # 与 dsh-self-evolution 的旧实现逐个会话文件比对结果
```

`npm run parity` 会读本机 `~/.dsh/sessions` 下的真实会话日志，
验证新包与原项目里的启发式实现解码结果完全一致（当前：30/30 一致）。

## License

MIT