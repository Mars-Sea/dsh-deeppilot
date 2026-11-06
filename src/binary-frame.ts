/**
 * 二进制帧（binaryFrames 能力）的线格式与上限。
 *
 * 为什么有它：会话导出块和附件图片原本以 base64 放进 JSON 文本帧，线上多 1/3
 * 体积，手机还要先解 JSON 再解 base64。二进制帧把原始字节直接放在帧尾：
 *
 *   [格式 u8 = 1][头部长度 u32 大端][头部 JSON（UTF-8）][原始字节]
 *
 * 头部就是普通 envelope（v/type/id/ts/payload），只是 payload 里不再有 data
 * 字段，请求 id 关联、诊断都沿用文本帧的规则。只有客户端在请求里带
 * `binary: true` 时 Bridge 才回这种帧；旧客户端永远收不到。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

/** 帧首字节。客户端遇到未知值直接丢弃该帧，留给以后扩展。 */
export const BINARY_FRAME_FORMAT = 1

/** 二进制模式下导出与附件的单块字节数。连接在发送缓冲降到 256 KiB 以下才发
 *  下一块，缓冲峰值约 512 KiB，远低于 4 MiB 的慢客户端断开线。 */
export const BINARY_CHUNK_BYTES = 256 * 1024

/** 二进制模式下单张附件原图的上限，对应 App 既有的 16 MiB base64 上限
 *  （16 MiB × 3/4）。超过回 E_TOO_LARGE，App 显示占位图。 */
export const MAX_BINARY_ATTACHMENT_BYTES = 12 * 1024 * 1024

/** 把 envelope 头部与原始字节拼成一帧。 */
export function encodeBinaryFrame(header: object, body: Uint8Array): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  const frame = Buffer.allocUnsafe(5 + headerBytes.length + body.length)
  frame.writeUInt8(BINARY_FRAME_FORMAT, 0)
  frame.writeUInt32BE(headerBytes.length, 1)
  headerBytes.copy(frame, 5)
  frame.set(body, 5 + headerBytes.length)
  return frame
}

/** 解析一帧；格式不对返回 undefined。插件自身不收二进制帧，这里供测试与工具复用。 */
export function decodeBinaryFrame(frame: Uint8Array): { header: unknown; body: Buffer } | undefined {
  const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
  if (buffer.length < 5 || buffer.readUInt8(0) !== BINARY_FRAME_FORMAT) return undefined
  const headerLength = buffer.readUInt32BE(1)
  if (5 + headerLength > buffer.length) return undefined
  try {
    return { header: JSON.parse(buffer.subarray(5, 5 + headerLength).toString('utf8')), body: buffer.subarray(5 + headerLength) }
  } catch {
    return undefined
  }
}

/**
 * 压缩帧（compressedFrames 能力）：`[格式 u8 = 2][整个 envelope JSON 的 deflate-raw 字节]`。
 *
 * 为什么有它：经 Funnel 的实测下行吞吐只有 40～80 KB/s，会话列表、最近消息这类
 * JSON 大帧压到 1/4～1/5 后传输时间同比缩短。只在客户端认证时声明
 * `acceptEncoding: ["deflate-raw"]` 后，对序列化后超过 COMPRESS_MIN_BYTES 的
 * 文本帧启用；小帧压缩收益抵不上开销，照旧发文本帧。level 1：压缩比 4.3 倍，
 * CPU 明显低于默认 level 6（5.3 倍）。
 */
export const COMPRESSED_FRAME_FORMAT = 2
export const COMPRESS_MIN_BYTES = 8 * 1024
export const COMPRESS_LEVEL = 1

export function encodeCompressedFrame(json: string): Buffer {
  const deflated = deflateRawSync(Buffer.from(json, 'utf8'), { level: COMPRESS_LEVEL })
  const frame = Buffer.allocUnsafe(1 + deflated.length)
  frame.writeUInt8(COMPRESSED_FRAME_FORMAT, 0)
  deflated.copy(frame, 1)
  return frame
}

/** 解出压缩帧里的 envelope；格式不对返回 undefined。插件自身不收，供测试与工具复用。 */
export function decodeCompressedFrame(frame: Uint8Array): unknown {
  const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
  if (buffer.length < 2 || buffer.readUInt8(0) !== COMPRESSED_FRAME_FORMAT) return undefined
  try {
    return JSON.parse(inflateRawSync(buffer.subarray(1)).toString('utf8'))
  } catch {
    return undefined
  }
}
