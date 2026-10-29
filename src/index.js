/**
 * multi-frame-zstd —— 解码「多个 zstd 帧首尾相接」的数据。
 *
 * 为什么需要它：Node 内置的 `zlib.zstdDecompressSync()` 与 zstd 流**都只解第一帧**
 * （实测：两帧拼接后只吐出第一帧的内容）。而很多日志系统是**每次 flush 追加一个独立帧**
 * —— dsh 的 `session.v4.jsonl.zstd` 就是这样（实测 10877B 的文件共 6 帧，首帧仅 187B）。
 * 不按帧边界逐帧解码，就只能读到 header，会误判成"文件里没有数据"。
 *
 * 生态里现成的解法都只支持单帧：fzstd、zstd-codec(WASM)、@mongodb-js/zstd(原生绑定)。
 * 这个包自己解析 RFC 8878 的帧结构（帧头 + 块序列），切出每一帧的精确字节范围，
 * 再交给 Node 内置的 zstd 解压器，零依赖、零原生模块。
 */
import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数（RFC 8878 §3.1.1，小端读出的数值）。 */
export const ZSTD_MAGIC = 0xfd2fb528
/** zstd 帧魔数的字节形式。 */
export const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 可跳过帧的魔数区间（RFC 8878 §3.1.2）。 */
const SKIPPABLE_MAGIC_MIN = 0x184d2a50
const SKIPPABLE_MAGIC_MAX = 0x184d2a5f
const SKIPPABLE_HEADER_SIZE = 8

export class ZstdError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'ZstdError'
  }
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  }
  if (typeof input === 'string') return Buffer.from(input, 'utf8')
  throw new TypeError('只接受 Buffer / Uint8Array / string')
}

function readLittleEndian(buf, pos, size) {
  if (size === 0) return 0
  if (size === 8) return Number(buf.readBigUInt64LE(pos))
  return buf.readUIntLE(pos, size)
}

/**
 * 解析一个帧的头部并走完它的块序列，返回该帧的精确字节长度。
 * 只读结构不解压，用来切边界。
 */
function readFrameHeader(buf, offset) {
  if (offset + 4 > buf.length) {
    throw new ZstdError(`偏移 ${offset} 处放不下帧魔数，数据被截断`)
  }
  const magic = buf.readUInt32LE(offset)

  if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX) {
    if (offset + SKIPPABLE_HEADER_SIZE > buf.length) {
      throw new ZstdError(`偏移 ${offset} 处的可跳过帧头不完整`)
    }
    const size = buf.readUInt32LE(offset + 4)
    const length = SKIPPABLE_HEADER_SIZE + size
    if (offset + length > buf.length) {
      throw new ZstdError(`偏移 ${offset} 处的可跳过帧超出缓冲区`)
    }
    return { skippable: true, length, offset, contentSize: null, dictionaryId: 0 }
  }

  if (magic !== ZSTD_MAGIC) {
    const seen = buf.subarray(offset, offset + 4).toString('hex')
    throw new ZstdError(`偏移 ${offset} 处不是 zstd 帧（读到 ${seen}）`)
  }

  if (offset + 5 > buf.length) {
    throw new ZstdError(`偏移 ${offset} 处的帧头不完整`)
  }
  const descriptor = buf[offset + 4]
  const fcsFlag = descriptor >> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const hasChecksum = (descriptor & 0x04) !== 0
  const didFlag = descriptor & 0x03

  let pos = offset + 5
  if (!singleSegment) {
    // Window_Descriptor
    if (pos >= buf.length) throw new ZstdError(`偏移 ${offset} 处的帧缺少 Window_Descriptor`)
    pos += 1
  }
  const didSize = [0, 1, 2, 4][didFlag]
  const dictionaryId = readLittleEndian(buf, pos, didSize)
  pos += didSize

  let fcsSize = [0, 2, 4, 8][fcsFlag]
  if (fcsFlag === 0 && singleSegment) fcsSize = 1
  let contentSize = null
  if (fcsSize > 0) {
    contentSize = readLittleEndian(buf, pos, fcsSize)
    if (fcsFlag === 1) contentSize += 256
    pos += fcsSize
  }

  // Data_Blocks：每块 3 字节块头，最后一块由 Last_Block 标志收尾。
  for (;;) {
    if (pos + 3 > buf.length) {
      throw new ZstdError(`偏移 ${offset} 的帧缺少完整的块头，数据被截断`)
    }
    const header = buf.readUIntLE(pos, 3)
    pos += 3
    const last = (header & 1) === 1
    const type = (header & 6) >> 1
    const size = header >>> 3
    if (type === 0) pos += size          // Raw_Block
    else if (type === 1) pos += 1        // RLE_Block
    else if (type === 2) pos += size     // Compressed_Block
    else throw new ZstdError(`偏移 ${offset} 的帧含保留的块类型（Reserved_Block）`)
    if (pos > buf.length) {
      throw new ZstdError(`偏移 ${offset} 的帧内容超出缓冲区，数据被截断`)
    }
    if (last) break
  }

  if (hasChecksum) {
    if (pos + 4 > buf.length) {
      throw new ZstdError(`偏移 ${offset} 的帧缺少内容校验和`)
    }
    pos += 4
  }

  return { skippable: false, length: pos - offset, offset, contentSize, dictionaryId }
}

/**
 * 只扫描帧边界，不解压。返回每一帧的 { offset, length, contentSize, dictionaryId }。
 *
 * @param {Buffer|Uint8Array|string} input
 * @param {{ strict?: boolean }} [options] strict=false 时，遇到坏数据就停并返回已识别的帧。
 */
export function scanFrames(input, options = {}) {
  const { strict = true } = options
  const buf = toBuffer(input)
  const frames = []
  let offset = 0
  while (offset < buf.length) {
    let header
    try {
      header = readFrameHeader(buf, offset)
    } catch (err) {
      if (strict) throw err
      break
    }
    if (header.skippable) {
      offset += header.length
      continue
    }
    frames.push({
      offset: header.offset,
      length: header.length,
      contentSize: header.contentSize,
      dictionaryId: header.dictionaryId
    })
    offset += header.length
  }
  return frames
}

/**
 * 解码每一帧，返回解压后的内容数组（顺序与输入一致）。
 *
 * @param {Buffer|Uint8Array|string} input
 * @param {{ strict?: boolean }} [options]
 * @returns {Buffer[]}
 */
export function decodeFrames(input, options = {}) {
  const { strict = true } = options
  const buf = toBuffer(input)
  const frames = []
  for (const frame of scanFrames(buf, { strict })) {
    if (frame.dictionaryId) {
      throw new ZstdError(
        `偏移 ${frame.offset} 的帧依赖 zstd 字典（ID ${frame.dictionaryId}），没有字典无法解码`
      )
    }
    const slice = buf.subarray(frame.offset, frame.offset + frame.length)
    let out
    try {
      out = zstdDecompressSync(slice)
    } catch (err) {
      if (strict) {
        throw new ZstdError(`偏移 ${frame.offset} 的帧解压失败：${err.message}`, { cause: err })
      }
      break
    }
    frames.push(out)
  }
  return frames
}

/**
 * 解码并把所有帧的内容拼成一个 Buffer。
 *
 * @param {Buffer|Uint8Array|string} input
 * @param {{ strict?: boolean }} [options]
 * @returns {Buffer}
 */
export function decodeConcat(input, options = {}) {
  const frames = decodeFrames(input, options)
  if (frames.length === 1) return frames[0]
  return Buffer.concat(frames)
}

/**
 * 解码并返回文本。
 *
 * @param {Buffer|Uint8Array|string} input
 * @param {{ strict?: boolean, encoding?: BufferEncoding }} [options]
 * @returns {string}
 */
export function decodeText(input, options = {}) {
  const { encoding = 'utf8', ...rest } = options
  return decodeConcat(input, rest).toString(encoding)
}

/** 缓冲区是否以 zstd 帧（或可跳过帧）开头。 */
export function isZstd(input) {
  const buf = toBuffer(input)
  if (buf.length < 4) return false
  const magic = buf.readUInt32LE(0)
  return magic === ZSTD_MAGIC || (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX)
}

/** 帧的数量（只扫描边界，不解压）。 */
export function frameCount(input, options = {}) {
  return scanFrames(input, options).length
}