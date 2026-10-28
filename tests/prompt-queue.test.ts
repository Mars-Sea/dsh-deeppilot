/**
 * 运行中排队与转向（promptQueue 能力）：inbox 投影折叠、requestId 互转、
 * Bridge 的快照推送时机与 updateQueue 的错误映射。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { HostBridge } from '../src/host-bridge.ts'
import type { ApiProxyLike, BridgeSink, MuxFrameLike } from '../src/host-bridge.ts'
import { documentPromptBlock } from '../src/document-payload.ts'
import { MAX_QUEUE_TEXT_CODE_POINTS, clientSendIdOf, projectQueue, promptRequestId } from '../src/prompt-queue.ts'

const sendId = () => `${Date.now()}-${randomUUID()}`

function userMessage(id: string, content: unknown[], rpcId?: string) {
  return { id, role: 'user', content, source: { kind: 'user', ...(rpcId !== undefined ? { rpcId } : {}) } }
}

function inbox(nextTurn: unknown[], nextStep: unknown[] = []) {
  return { 'next-turn': nextTurn, 'next-step': nextStep }
}

/** 可控 mux 的假代理；withQueue=false 模拟没有 updateQueue 的旧 Host。 */
function makeProxy(opts: { withQueue?: boolean; baseline?: () => unknown } = {}) {
  const queue: Array<{ payload: MuxFrameLike }> = []
  const prompts: any[] = []
  const updates: any[] = []
  let updateResult: any = { result: { ok: true, value: { accepted: true } } }
  const proxy: ApiProxyLike = {
    sessions: {
      list: async () => ({ result: { ok: true, value: { items: [] } } }),
      history: async () => ({ result: { ok: true, value: { events: [], hasMore: false } } }),
      prompt: async (request) => {
        prompts.push(request)
        return { result: { ok: true, value: { accepted: true } } }
      },
      create: async () => ({ result: { ok: true, value: { sessionId: 's-new' } } }),
      projections: async () => {
        const value = opts.baseline?.()
        if (value instanceof Error) throw value
        return { result: { ok: true, value: (value ?? null) as any } }
      },
      ...(opts.withQueue === false ? {} : {
        updateQueue: async (request: any) => {
          updates.push(request)
          return updateResult
        },
      }),
    },
    respond: async () => ({ accepted: true }),
    events: {
      mux: async function* (_req, signal) {
        while (!signal.aborted) {
          if (queue.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 2))
            continue
          }
          yield queue.shift()!
        }
      },
      host: async function* () {},
    },
  }
  return {
    proxy, prompts, updates,
    push: (frame: MuxFrameLike) => queue.push({ payload: frame }),
    setUpdateResult: (value: any) => { updateResult = value },
  }
}

function makeSink(store: Array<{ type: string; payload: any; seq?: number }>): BridgeSink {
  return {
    push: (type, payload, seq) => store.push({ type, payload, ...(seq !== undefined ? { seq } : {}) }),
    lastCursor: () => 0,
    replay: () => {},
    replayDone: () => {},
    resync: () => {},
    canReceive: () => true,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const queueFrames = <T extends { type: string }>(frames: T[]) => frames.filter((f) => f.type === 's2c.session.queue')

// ---------- 纯函数 ----------

test('requestId 与 clientSendId 互转；别家来源与畸形 ID 都不认', () => {
  const id = sendId()
  assert.equal(promptRequestId(id), 'dp:' + id)
  assert.equal(clientSendIdOf(promptRequestId(id)), id)
  assert.equal(clientSendIdOf(randomUUID()), undefined, 'Web 端的随机 requestId 不是本 Bridge 发出的')
  assert.equal(clientSendIdOf('dp:not-a-send-id'), undefined)
  assert.equal(clientSendIdOf(undefined), undefined)
})

test('inbox 折叠：先排队后转向，附件计数，文档块不进正文，只给 dp: 来源带 clientSendId', () => {
  const id = sendId()
  const doc = documentPromptBlock({ name: 'a.md', mediaType: 'text/markdown', text: '文档正文' })
  const items = projectQueue(inbox(
    [
      userMessage('m1', [{ type: 'text', text: '第二条' }, { type: 'image', attachment: {} }, { type: 'text', text: doc }], promptRequestId(id)),
      userMessage('m2', [{ type: 'text', text: '网页端发的' }], randomUUID()),
      { content: [{ type: 'text', text: '没有 id 的项被跳过' }] },
    ],
    [userMessage('m3', [{ type: 'text', text: '先别改测试' }])],
  ))
  assert.deepEqual(items, [
    { itemId: 'm1', placement: 'queued', text: '第二条', imageCount: 1, documentCount: 1, clientSendId: id },
    { itemId: 'm2', placement: 'queued', text: '网页端发的', imageCount: 0, documentCount: 0 },
    { itemId: 'm3', placement: 'steering', text: '先别改测试', imageCount: 0, documentCount: 0 },
  ])
})

test('inbox 折叠：正文按码点截断并置 truncated；读不懂的值返回 undefined 而不是空队列', () => {
  const [item] = projectQueue(inbox([userMessage('m', [{ type: 'text', text: '汉'.repeat(MAX_QUEUE_TEXT_CODE_POINTS + 10) }])]))!
  assert.equal(Array.from(item!.text).length, MAX_QUEUE_TEXT_CODE_POINTS)
  assert.equal(item!.truncated, true)
  assert.deepEqual(projectQueue(inbox([])), [])
  assert.equal(projectQueue(null), undefined)
  assert.equal(projectQueue({ 'next-turn': [] }), undefined)
})

// ---------- Bridge ----------

test('能力位跟随 Host 是否提供 updateQueue', () => {
  assert.equal(new HostBridge(makeProxy().proxy, 100).capabilities.promptQueue, true)
  assert.equal(new HostBridge(makeProxy({ withQueue: false }).proxy, 100).capabilities.promptQueue, false)
})

test('实时 inbox 变化广播整表快照，内容不变的重复通知不再推送', async () => {
  const h = makeProxy()
  const bridge = new HostBridge(h.proxy, 100)
  const frames: Array<{ type: string; payload: any; seq?: number }> = []
  bridge.addSink(makeSink(frames))
  bridge.start()
  h.push({ type: 'session/projection', sessionId: 's', key: 'inbox', value: inbox([userMessage('m1', [{ type: 'text', text: '一' }])]) } as MuxFrameLike)
  h.push({ type: 'session/projection', sessionId: 's', key: 'inbox', value: inbox([userMessage('m1', [{ type: 'text', text: '一' }])]) } as MuxFrameLike)
  // 转向的两步：先离开 next-turn，再进入 next-step。
  h.push({ type: 'session/projection', sessionId: 's', key: 'inbox', value: inbox([]) } as MuxFrameLike)
  h.push({ type: 'session/projection', sessionId: 's', key: 'inbox', value: inbox([], [userMessage('m1', [{ type: 'text', text: '一' }])]) } as MuxFrameLike)
  await settle()
  const pushed = queueFrames(frames)
  assert.deepEqual(pushed.map((f) => f.payload.items.map((i: any) => `${i.itemId}:${i.placement}`)), [['m1:queued'], [], ['m1:steering']])
  assert.ok(pushed.every((f) => typeof f.seq === 'number'), '变化推送占 seq、进重放环')
  bridge.dispose()
})

test('旧 Host 与子代理会话都不推送队列', async () => {
  const legacy = makeProxy({ withQueue: false })
  const legacyBridge = new HostBridge(legacy.proxy, 100)
  const legacyFrames: Array<{ type: string; payload: any }> = []
  legacyBridge.addSink(makeSink(legacyFrames))
  legacyBridge.start()
  legacy.push({ type: 'session/projection', sessionId: 's', key: 'inbox', value: inbox([userMessage('m', [])]) } as MuxFrameLike)

  const h = makeProxy()
  const bridge = new HostBridge(h.proxy, 100)
  const frames: Array<{ type: string; payload: any }> = []
  bridge.addSink(makeSink(frames))
  bridge.start()
  h.push({ type: 'session/event', sessionId: 'child', isSubagent: true, event: { type: 'turn/start', seq: 1, data: {} } } as MuxFrameLike)
  h.push({ type: 'session/projection', sessionId: 'child', key: 'inbox', value: inbox([userMessage('m', [])]) } as MuxFrameLike)
  await settle()
  assert.deepEqual(queueFrames(legacyFrames), [])
  assert.deepEqual(queueFrames(frames), [])
  legacyBridge.dispose()
  bridge.dispose()
})

test('打开会话：tail 之后点对点补发基线快照（不占 seq、不广播），空队列也发', async () => {
  const h = makeProxy({ baseline: () => ({ asOfSeq: 1, values: { inbox: inbox([]) } }) })
  const bridge = new HostBridge(h.proxy, 100)
  const others: Array<{ type: string; payload: any }> = []
  bridge.addSink(makeSink(others))
  bridge.start()
  const opener: Array<{ type: string; payload: any; seq?: number }> = []
  assert.equal(await bridge.openSession(makeSink(opener), 's', 10), true)
  await settle()
  assert.deepEqual(opener.map((f) => f.type), ['s2c.session.tail', 's2c.session.queue'])
  assert.deepEqual(opener[1], { type: 's2c.session.queue', payload: { sessionId: 's', items: [] } })
  assert.deepEqual(queueFrames(others), [], '基线不广播给其他连接')
  bridge.dispose()
})

test('打开会话：基线不覆盖已收到的实时值；基线读取失败时不发快照', async () => {
  const h = makeProxy({ baseline: () => ({ asOfSeq: 1, values: { inbox: inbox([]) } }) })
  const bridge = new HostBridge(h.proxy, 100)
  bridge.start()
  h.push({ type: 'session/projection', sessionId: 's', key: 'inbox', value: inbox([userMessage('live', [])]) } as MuxFrameLike)
  await settle()
  const opener: Array<{ type: string; payload: any }> = []
  await bridge.openSession(makeSink(opener), 's', 10)
  await settle()
  assert.deepEqual(queueFrames(opener)[0]?.payload.items.map((i: any) => i.itemId), ['live'])
  bridge.dispose()

  const failing = makeProxy({ baseline: () => new Error('boom') })
  const failingBridge = new HostBridge(failing.proxy, 100)
  failingBridge.start()
  const frames: Array<{ type: string; payload: any }> = []
  await failingBridge.openSession(makeSink(frames), 's', 10)
  await settle()
  assert.deepEqual(queueFrames(frames), [], '未知不等于空队列')
  failingBridge.dispose()
})

test('sendPrompt：带 clientSendId 时 requestId 确定，mode 原样透传；缺省仍是 queue 与随机 ID', async () => {
  const h = makeProxy()
  const bridge = new HostBridge(h.proxy, 100)
  const id = sendId()
  await bridge.sendPrompt('s', '插队', [], [], { mode: 'steer', clientSendId: id })
  await bridge.sendPrompt('s', '普通')
  assert.equal(h.prompts[0].rpcId, 'dp:' + id)
  assert.equal(h.prompts[0].payload.mode, 'steer')
  assert.equal(h.prompts[1].payload.mode, 'queue')
  assert.ok(!String(h.prompts[1].rpcId).startsWith('dp:'))
  bridge.dispose()
})

test('updateQueue：动作原样转给 Host，错误按队列域映射，旧 Host 回 E_UNSUPPORTED', async () => {
  const h = makeProxy()
  const bridge = new HostBridge(h.proxy, 100)
  assert.deepEqual(await bridge.updateQueue('s', 'm1', 'steer'), { ok: true, value: { sessionId: 's', itemId: 'm1' } })
  assert.deepEqual(h.updates[0].payload, { sessionId: 's', itemId: 'm1', action: { kind: 'steer' } })
  h.setUpdateResult({ result: { ok: false, error: { code: 'session/steer-unavailable', message: 'current turn no longer accepts steering' } } })
  assert.equal((await bridge.updateQueue('s', 'm1', 'steer') as any).code, 'E_STEER_UNAVAILABLE')
  h.setUpdateResult({ result: { ok: false, error: { code: 'session/queue-item-not-found' } } })
  assert.equal((await bridge.updateQueue('s', 'm1', 'remove') as any).code, 'E_NOT_FOUND')
  bridge.dispose()

  const legacy = new HostBridge(makeProxy({ withQueue: false }).proxy, 100)
  assert.equal((await legacy.updateQueue('s', 'm1', 'remove') as any).code, 'E_UNSUPPORTED')
  legacy.dispose()
})
