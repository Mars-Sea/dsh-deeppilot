import { test } from 'node:test'
import assert from 'node:assert'
import { ImageRefIndex, MAX_IMAGE_REF_SCAN_PAGES } from '../src/image-ref-index.ts'
import { eventImageRefs } from '../src/host-event-projection.ts'
import type { SessionEventLike } from '../src/host-api.ts'

// DSH 0.2.2 的 ImageAttachmentRef：宿主读图时逐项核对 mediaType/bytes/width/height。
const ref = (attachmentId: string, extra: Record<string, unknown> = {}) => ({
  attachmentId, mediaType: 'image/png', bytes: 1234, width: 640, height: 480, ...extra,
})

const userImage = (seq: number, attachment: Record<string, unknown>): SessionEventLike => ({
  type: 'user/message', seq,
  data: { turn: 1, step: 0, message: { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', attachment }] } },
})

const toolImage = (seq: number, attachment: Record<string, unknown>, error?: unknown): SessionEventLike => ({
  type: 'tool/result', seq,
  data: { callId: `c${seq}`, ...(error === undefined ? {} : { error }), message: { role: 'tool', content: [{ type: 'image', attachment }] } },
})

test('eventImageRefs keeps the host reference verbatim for user and successful tool rows', () => {
  const withExtra = ref('att-1', { name: 'a.png', originalDimensions: { width: 4000, height: 3000 }, futureField: 1 })
  assert.deepEqual(eventImageRefs(userImage(1, withExtra)), [withExtra],
    'fields the plugin does not know must survive, the host verifies them')
  assert.deepEqual(eventImageRefs(toolImage(2, ref('att-2'))), [ref('att-2')])
})

test('eventImageRefs ignores rows the phone never sees and malformed references', () => {
  // 失败的工具结果不投影附件，手机拿不到它的 attachmentId。
  assert.deepEqual(eventImageRefs(toolImage(1, ref('att-err'), { message: 'boom' })), [])
  assert.deepEqual(eventImageRefs({ type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'image', attachment: ref('x') }] } } }), [])
  assert.deepEqual(eventImageRefs(userImage(3, { mediaType: 'image/png' })), [])
  assert.deepEqual(eventImageRefs(userImage(4, { attachmentId: '' })), [])
})

test('remembered references resolve without touching history and stay per session', async () => {
  const index = new ImageRefIndex()
  index.remember('s1', [userImage(1, ref('att-1'))])
  let reads = 0
  const readPage = async () => { reads++; return { events: [], hasMore: false } }
  assert.deepEqual(await index.resolve('s1', 'att-1', readPage), ref('att-1'))
  assert.equal(reads, 0)
  // 同一 attachmentId 在别的会话里不算：这正是新宿主不再做的会话归属校验。
  assert.equal(await index.resolve('s2', 'att-1', readPage), undefined)
  assert.equal(reads, 1)
})

test('a cache miss pages backwards through history and concurrent misses share one scan', async () => {
  const index = new ImageRefIndex()
  const calls: Array<number | undefined> = []
  const readPage = async (_sessionId: string, beforeSeq: number | undefined) => {
    calls.push(beforeSeq)
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (beforeSeq === undefined) return { events: [userImage(20, ref('att-new')), userImage(21, ref('att-new2'))], hasMore: true }
    return { events: [toolImage(5, ref('att-old'))], hasMore: false }
  }
  const [a, b] = await Promise.all([
    index.resolve('s1', 'att-old', readPage),
    index.resolve('s1', 'att-new', readPage),
  ])
  assert.deepEqual(a, ref('att-old'))
  assert.deepEqual(b, ref('att-new'))
  assert.deepEqual(calls, [undefined, 20], 'pages walk back from the oldest seq, once for both requests')
})

test('history scan stops at the page cap and when the boundary does not advance', async () => {
  const index = new ImageRefIndex()
  let reads = 0
  let seq = 100_000
  await index.resolve('s1', 'missing', async () => {
    reads++
    seq -= 10
    return { events: [{ type: 'turn/end', seq }], hasMore: true }
  })
  assert.equal(reads, MAX_IMAGE_REF_SCAN_PAGES)

  reads = 0
  await index.resolve('s1', 'missing', async () => {
    reads++
    return { events: [{ type: 'turn/end', seq: 7 }], hasMore: true }
  })
  assert.equal(reads, 2, 'a host that repeats the same page must not be read forever')
})

test('the cache evicts least recently used references beyond its cap', async () => {
  const index = new ImageRefIndex(2)
  index.remember('s', [userImage(1, ref('a')), userImage(2, ref('b'))])
  assert.ok(index.peek('s', 'a'), 'touch a so b becomes the oldest')
  index.remember('s', [userImage(3, ref('c'))])
  assert.ok(index.peek('s', 'a'))
  assert.equal(index.peek('s', 'b'), undefined)
  assert.ok(index.peek('s', 'c'))
})
