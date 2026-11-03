import assert from 'node:assert/strict'
import test from 'node:test'
import { BINARY_FRAME_FORMAT, decodeBinaryFrame, encodeBinaryFrame } from '../src/binary-frame.ts'

test('二进制帧：格式字节、大端头部长度、UTF-8 头部与原始字节依次排列', () => {
  const header = { v: 2, type: 's2c.session.export.chunk', id: '请求-1', payload: { index: 3 } }
  const body = Buffer.from([0, 1, 2, 255])
  const frame = encodeBinaryFrame(header, body)
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  assert.equal(frame[0], BINARY_FRAME_FORMAT)
  assert.equal(frame.readUInt32BE(1), headerBytes.length)
  assert.deepEqual(frame.subarray(5, 5 + headerBytes.length), headerBytes)
  assert.deepEqual(frame.subarray(5 + headerBytes.length), body)
  assert.deepEqual(decodeBinaryFrame(frame), { header, body })
})

test('二进制帧：空正文可往返，残缺或未知格式解析失败', () => {
  assert.deepEqual(decodeBinaryFrame(encodeBinaryFrame({ a: 1 }, new Uint8Array()))?.body.length, 0)
  const frame = encodeBinaryFrame({ a: 1 }, Buffer.from('x'))
  assert.equal(decodeBinaryFrame(frame.subarray(0, 4)), undefined)
  assert.equal(decodeBinaryFrame(Buffer.concat([Buffer.from([9]), frame.subarray(1)])), undefined)
  const truncated = Buffer.from(frame); truncated.writeUInt32BE(1000, 1)
  assert.equal(decodeBinaryFrame(truncated), undefined)
  const badJson = Buffer.from(frame); badJson[5] = 0x7b + 1
  assert.equal(decodeBinaryFrame(badJson), undefined)
})
