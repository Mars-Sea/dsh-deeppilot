import { test } from 'node:test'
import assert from 'node:assert'
import { HostBridge } from '../src/host-bridge.ts'
import type { ApiProxyLike, BridgeSink, MuxFrameLike } from '../src/host-bridge.ts'
import {
  MAX_QUIET_REASON_CHARS,
  QUIET_COMPLETION_TOOL_NAME,
  QuietCompletionTracker,
  quietCompletionTool,
  registerQuietCompletionTool,
} from '../src/quiet-completion.ts'

// 计划任务按需完成通知（#35）：轮次判定、工具行为与 HostBridge 的通知抑制。

type Tool = {
  name: string
  parameters: unknown
  output: { render(args: unknown, value: unknown): Array<{ type: string; text: string }> }
  execute(args: unknown, exec: { agent?: { sessionId?: string } }): Promise<{ suppressed: boolean; note?: string }>
}

/** 最小 mux 假宿主：只提供 HostBridge 启动与收事件所需的接口。 */
function makeProxy(schedule?: unknown) {
  const queue: MuxFrameLike[] = []
  const proxy = {
    sessions: {
      list: async () => ({ result: { ok: true, value: { items: [] } } }),
      history: async () => ({ result: { ok: true, value: { events: [], hasMore: false } } }),
    },
    respond: async () => ({ accepted: true }),
    events: {
      mux: async function* (_req: unknown, signal: AbortSignal) {
        while (!signal.aborted) {
          if (queue.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 5))
            continue
          }
          const { rpcId, ...payload } = queue.shift()!
          yield { ...(rpcId ? { rpcId } : {}), payload }
        }
      },
      host: async function* () {},
    },
    ...(schedule === undefined ? {} : { schedule }),
  } as unknown as ApiProxyLike
  return { proxy, push: (frame: MuxFrameLike) => queue.push(frame) }
}

function collectingSink(store: Array<{ type: string; payload: any }>): BridgeSink {
  return {
    push: (type, payload) => store.push({ type, payload }),
    lastCursor: () => 0,
    replay: () => {},
    replayDone: () => {},
    resync: () => {},
    canReceive: () => true,
  }
}

let seq = 0
const userMessage = (sessionId: string, sourceKind: string) => ({
  type: 'session/event', rpcId: 'u' + (++seq), sessionId,
  event: { type: 'user/message', seq: ++seq, data: { message: { role: 'user', content: [{ type: 'text', text: '检查服务状态' }], source: { kind: sourceKind } } } },
})
const assistantText = (sessionId: string, text: string) => ({
  type: 'session/event', rpcId: 'a' + (++seq), sessionId,
  event: { type: 'assistant/message', seq: ++seq, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } },
})
const turnEnd = (sessionId: string, kind = 'completed') => ({
  type: 'session/event', rpcId: 't' + (++seq), sessionId,
  event: { type: 'turn/end', seq: ++seq, data: { reason: { kind } } },
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

/** 启动桥接并挂一个在线设备；返回推帧函数、工具与收到的通知。 */
function harness() {
  const { proxy, push } = makeProxy()
  const bridge = new HostBridge(proxy, 100)
  const frames: Array<{ type: string; payload: any }> = []
  const pushes: unknown[] = []
  bridge.setPushOutlet({ fanOut: (notification: unknown) => pushes.push(notification) } as never)
  bridge.start()
  bridge.addSink(collectingSink(frames))
  const tool = quietCompletionTool(bridge.quietCompletion) as Tool
  const notifies = () => frames.filter((frame) => frame.type === 's2c.notify')
  return { bridge, push, tool, frames, pushes, notifies }
}

test('计划任务轮次中调用工具且成功结束：不写 s2c.notify、不推送，turn.end 照常记录', async () => {
  const h = harness()
  try {
    h.push(userMessage('s1', 'schedule') as MuxFrameLike)
    await settle()
    const result = await h.tool.execute({ reason: '全部正常' }, { agent: { sessionId: 's1' } })
    assert.deepEqual(result, { suppressed: true })
    h.push(assistantText('s1', '一切正常') as MuxFrameLike)
    h.push(turnEnd('s1') as MuxFrameLike)
    await settle()
    assert.equal(h.notifies().length, 0)
    assert.equal(h.pushes.length, 0)
    assert.ok(h.frames.some((frame) => frame.type === 's2c.session.event' && frame.payload.kind === 'turn.end'))
  } finally {
    h.bridge.dispose()
  }
})

test('计划任务轮次未调用工具：照常通知', async () => {
  const h = harness()
  try {
    h.push(userMessage('s1', 'schedule') as MuxFrameLike)
    h.push(turnEnd('s1') as MuxFrameLike)
    await settle()
    assert.deepEqual(h.notifies().map((frame) => frame.payload.category), ['turn.completed'])
    assert.equal(h.pushes.length, 1)
  } finally {
    h.bridge.dispose()
  }
})

test('调用工具后本轮失败：照常发 session.error', async () => {
  const h = harness()
  try {
    h.push(userMessage('s1', 'schedule') as MuxFrameLike)
    await settle()
    await h.tool.execute({ reason: '无变化' }, { agent: { sessionId: 's1' } })
    h.push(turnEnd('s1', 'error') as MuxFrameLike)
    await settle()
    assert.deepEqual(h.notifies().map((frame) => frame.payload.category), ['session.error'])
  } finally {
    h.bridge.dispose()
  }
})

test('用户中途插话：撤销静默，照常通知；之后调用工具返回 suppressed=false', async () => {
  const h = harness()
  try {
    h.push(userMessage('s1', 'schedule') as MuxFrameLike)
    await settle()
    await h.tool.execute({ reason: '无变化' }, { agent: { sessionId: 's1' } })
    h.push(userMessage('s1', 'user') as MuxFrameLike)
    await settle()
    const late = await h.tool.execute({ reason: '无变化' }, { agent: { sessionId: 's1' } })
    assert.equal(late.suppressed, false)
    h.push(turnEnd('s1') as MuxFrameLike)
    await settle()
    assert.equal(h.notifies().length, 1)
  } finally {
    h.bridge.dispose()
  }
})

test('普通轮次调用工具：返回 suppressed=false 并说明原因，照常通知', async () => {
  const h = harness()
  try {
    h.push(userMessage('s1', 'user') as MuxFrameLike)
    await settle()
    const result = await h.tool.execute({ reason: '无变化' }, { agent: { sessionId: 's1' } })
    assert.equal(result.suppressed, false)
    assert.match(result.note ?? '', /not started by a scheduled task/)
    h.push(turnEnd('s1') as MuxFrameLike)
    await settle()
    assert.equal(h.notifies().length, 1)
  } finally {
    h.bridge.dispose()
  }
})

test('静默只作用于本轮：下一轮默认通知', async () => {
  const h = harness()
  try {
    h.push(userMessage('s1', 'schedule') as MuxFrameLike)
    await settle()
    await h.tool.execute({ reason: '无变化' }, { agent: { sessionId: 's1' } })
    h.push(turnEnd('s1') as MuxFrameLike)
    h.push(userMessage('s1', 'schedule') as MuxFrameLike)
    h.push(turnEnd('s1') as MuxFrameLike)
    await settle()
    assert.equal(h.notifies().length, 1, '第二轮没调用工具，必须通知')
  } finally {
    h.bridge.dispose()
  }
})

test('静默轮次中的审批照常通知，只跳过完成通知', async () => {
  const h = harness()
  try {
    h.push(userMessage('s1', 'schedule') as MuxFrameLike)
    await settle()
    await h.tool.execute({ reason: '无变化' }, { agent: { sessionId: 's1' } })
    h.push({ type: 'approval/requested', rpcId: 'ap-1', sessionId: 's1', approvalId: 'a1', toolName: 'bash', reason: 'rm -rf build' } as MuxFrameLike)
    h.push(turnEnd('s1') as MuxFrameLike)
    await settle()
    assert.deepEqual(h.notifies().map((frame) => frame.payload.category), ['approval.required'])
  } finally {
    h.bridge.dispose()
  }
})

test('同一轮再来一条计划任务投递：撤销已请求的静默', () => {
  const tracker = new QuietCompletionTracker()
  tracker.noteUserMessage('s1', 'schedule')
  tracker.requestQuiet('s1')
  tracker.noteUserMessage('s1', 'schedule')
  assert.equal(tracker.consumeTurnEnd('s1', true), false)
})

test('注入的上下文消息不影响轮次判定；旧宿主无来源按用户消息处理', () => {
  const tracker = new QuietCompletionTracker()
  tracker.noteUserMessage('s1', 'schedule')
  tracker.noteUserMessage('s1', 'skill')
  tracker.requestQuiet('s1')
  assert.equal(tracker.consumeTurnEnd('s1', true), true)

  tracker.noteUserMessage('s1', 'schedule')
  tracker.requestQuiet('s1')
  tracker.noteUserMessage('s1', undefined)
  assert.equal(tracker.consumeTurnEnd('s1', true), false)
})

test('when 条件只对计划任务会话放行；集合是粘性的', () => {
  const tracker = new QuietCompletionTracker()
  let options: { when?: (context: { agent?: { sessionId?: string } }) => boolean } | undefined
  let registered: Tool | undefined
  const dispose = registerQuietCompletionTool({
    register: (definition, opts) => {
      registered = definition as Tool
      options = opts
      return () => {}
    },
  }, tracker)
  assert.equal(registered?.name, QUIET_COMPLETION_TOOL_NAME)
  assert.equal(typeof dispose, 'function')
  const when = options?.when
  assert.ok(when)
  assert.equal(when({ agent: { sessionId: 's1' } }), false)
  assert.equal(when({}), false)
  tracker.noteUserMessage('s1', 'schedule')
  tracker.consumeTurnEnd('s1', true)
  tracker.noteUserMessage('s1', 'user')
  assert.equal(when({ agent: { sessionId: 's1' } }), true, '加入后不随轮次或用户消息移除')
})

test('启动预热：从宿主任务列表取投递目标会话，全量分页', async () => {
  const pages = [
    { tasks: [
      { target: { kind: 'session', sessionId: 'existing' } },
      { target: { kind: 'new_once', sessionId: 'reserved' } },
    ], total: 3 },
    { tasks: [
      { target: { kind: 'new' }, lastDelivery: { targetSessionId: 'fresh' } },
    ], total: 3 },
  ]
  const offsets: number[] = []
  const { proxy } = makeProxy({
    mode: 'host',
    list: async (request: { payload: { offset: number } }) => {
      offsets.push(request.payload.offset)
      const page = pages[offsets.length - 1] ?? { tasks: [], total: 3 }
      return { result: { ok: true, value: { ...page, shown: page.tasks.length, limit: 500, offset: request.payload.offset } } }
    },
  })
  const bridge = new HostBridge(proxy, 100)
  try {
    await bridge.seedQuietCompletionSessions()
    assert.deepEqual(offsets, [0, 2])
    for (const id of ['existing', 'reserved', 'fresh']) {
      assert.equal(bridge.quietCompletion.isScheduleSession(id), true, id)
    }
    assert.equal(bridge.quietCompletion.isScheduleSession('other'), false)
  } finally {
    bridge.dispose()
  }
})

test('会话级宿主不预热（工具也不注册，见 index.ts）', async () => {
  const { proxy } = makeProxy({ mode: 'legacy', list: async () => { throw new Error('must not list') } })
  const bridge = new HostBridge(proxy, 100)
  try {
    await bridge.seedQuietCompletionSessions()
    assert.equal(bridge.capabilities.schedulesHost, false)
  } finally {
    bridge.dispose()
  }
})

test('工具定义：参数 schema、reason 截断与渲染文案', async () => {
  const tracker = new QuietCompletionTracker()
  const logs: string[] = []
  const tool = quietCompletionTool(tracker, (message) => logs.push(message)) as Tool
  assert.deepEqual(tool.parameters, {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: {
        type: 'string',
        description: `Why this run does not need the user's attention (at most ${MAX_QUIET_REASON_CHARS} characters).`,
      },
    },
  })
  tracker.noteUserMessage('s1', 'schedule')
  await tool.execute({ reason: 'x'.repeat(500) }, { agent: { sessionId: 's1' } })
  assert.match(logs[0], new RegExp(`reasonChars=${MAX_QUIET_REASON_CHARS}$`))
  assert.ok(!logs[0].includes('xxx'), '日志不打 reason 原文')
  assert.match(tool.output.render({}, { suppressed: true })[0].text, /will not be sent/)
  assert.match(tool.output.render({}, { suppressed: false, note: 'n' })[0].text, /^n$/)
})
