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
  scheduledTurnOf,
  type SessionLogLike,
} from '../src/quiet-completion.ts'

// 计划任务按需完成通知（#35）：会话日志判定、工具行为与 HostBridge 的通知抑制。
// 日志事件形状取自 DSH 0.2.2-rc.1 实测：`when` 求值时只有 turn/start 与 inbox 拼接事件，
// 计划任务投递是 target='next-turn' 的 schedule 条目，任务变更提示是 target='next-step'。

type Tool = {
  name: string
  parameters: unknown
  output: { render(args: unknown, value: unknown): Array<{ type: string; text: string }> }
  execute(args: unknown, exec: { agent?: { session?: unknown } }): Promise<{ suppressed: boolean; note?: string }>
}
type LogEvent = { type: string; data?: unknown }

/** 可追加的假会话日志：seq 即事件下标。 */
function sessionLog(id: string, events: LogEvent[] = []): SessionLogLike & { push(...events: LogEvent[]): void } {
  const log = [...events]
  return {
    id,
    get seq() { return log.length },
    eventAt: (seq) => log[seq],
    push: (...more) => { log.push(...more) },
  }
}

const turnStart = (turn: number): LogEvent => ({ type: 'turn/start', data: { turn } })
const spliced = (target: 'next-turn' | 'next-step', kind: string): LogEvent => ({
  type: 'agent/inbox/spliced',
  data: { target, start: 0, inserted: [{ role: 'user', source: { kind }, content: [{ type: 'text', text: '…' }] }] },
})
const delivery = spliced('next-turn', 'schedule')
const changeNotice = spliced('next-step', 'schedule')
const userPrompt = spliced('next-turn', 'user')
const userMessageEvent = (kind: string): LogEvent => ({ type: 'user/message', data: { message: { role: 'user', source: { kind } } } })

test('scheduledTurnOf：投递驱动的轮次为真，并读出轮次号', () => {
  // 实测顺序：投递先插入 next-turn，turn/start 之后只有取走（不带内容）。
  const consumed: LogEvent = { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } }
  assert.deepEqual(scheduledTurnOf(sessionLog('s', [changeNotice, delivery, turnStart(3), consumed])), { scheduled: true, turn: 3 })
  // 执行工具时 user/message 已落盘，不影响判定。
  assert.deepEqual(scheduledTurnOf(sessionLog('s', [
    delivery, turnStart(1), consumed, userMessageEvent('schedule'), userMessageEvent('runtime-context'),
  ])), { scheduled: true, turn: 1 })
  // 上一轮忙时排进来的投递，在本轮开始时被取走。
  assert.equal(scheduledTurnOf(sessionLog('s', [userPrompt, turnStart(1), delivery, turnStart(2)])).scheduled, true)
})

test('scheduledTurnOf：用户轮次、任务变更提示与用户插话都不算', () => {
  assert.equal(scheduledTurnOf(sessionLog('s', [userPrompt, turnStart(1)])).scheduled, false)
  assert.equal(scheduledTurnOf(sessionLog('s', [userPrompt, changeNotice, turnStart(1)])).scheduled, false, '变更提示不是投递')
  assert.equal(scheduledTurnOf(sessionLog('s', [delivery, userPrompt, turnStart(1)])).scheduled, false, '最后插入的是用户消息')
  assert.equal(scheduledTurnOf(sessionLog('s', [delivery, turnStart(1), spliced('next-step', 'user')])).scheduled, false, '中途插话')
  // 上一轮之前的投递已被上一轮取走，不影响本轮。
  assert.equal(scheduledTurnOf(sessionLog('s', [delivery, turnStart(1), turnStart(2)])).scheduled, false)
  // 本轮开始后才插入的投递属于下一轮。
  assert.equal(scheduledTurnOf(sessionLog('s', [userPrompt, turnStart(1), delivery])).scheduled, false)
  // 扫不到 turn/start：按普通轮次处理。
  assert.equal(scheduledTurnOf(sessionLog('s', [delivery])).scheduled, false)
})

test('when：计划任务轮次首轮即放行并加入粘性集合；普通会话不放行', () => {
  const tracker = new QuietCompletionTracker()
  const logs: string[] = []
  let when: ((context: { agent?: { session?: unknown } }) => boolean) | undefined
  let registered: Tool | undefined
  registerQuietCompletionTool({
    register: (definition, options) => {
      registered = definition as Tool
      when = options?.when
      return () => {}
    },
  }, tracker, (message) => logs.push(message))
  assert.equal(registered?.name, QUIET_COMPLETION_TOOL_NAME)
  assert.ok(when)

  assert.equal(when({}), false, '没有会话')
  const plain = sessionLog('plain', [userPrompt, turnStart(1)])
  assert.equal(when({ agent: { session: plain } }), false)

  const scheduled = sessionLog('sched', [delivery, turnStart(1)])
  assert.equal(when({ agent: { session: scheduled } }), true)
  assert.equal(when({ agent: { session: scheduled } }), true)
  assert.deepEqual(logs, ['quiet completion: session joined scheduled set session=sched'], '加入集合只记一次')

  scheduled.push(userPrompt, turnStart(2))
  assert.equal(when({ agent: { session: scheduled } }), true, '粘性：之后的用户轮次仍可见，避免工具反复增减')
})

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

let rpc = 0
const muxEvent = (sessionId: string, seq: number, type: string, data: unknown): MuxFrameLike =>
  ({ type: 'session/event', rpcId: 'r' + (++rpc), sessionId, event: { type, seq, data } }) as MuxFrameLike
const turnEndFrame = (sessionId: string, seq: number, turn: number, kind = 'completed') =>
  muxEvent(sessionId, seq, 'turn/end', { turn, reason: { kind } })
const userMessageFrame = (sessionId: string, seq: number, kind: string) =>
  muxEvent(sessionId, seq, 'user/message', { message: { role: 'user', content: [{ type: 'text', text: '…' }], source: { kind } } })
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
  /** 在给定会话日志上调用工具（宿主进程内同步读日志）。 */
  const callTool = (session: SessionLogLike) => tool.execute({ reason: '全部正常' }, { agent: { session } })
  return { bridge, push, callTool, frames, pushes, notifies }
}

test('计划任务轮次中调用工具且成功结束：不写 s2c.notify、不推送，turn.end 照常记录', async () => {
  const h = harness()
  try {
    const result = await h.callTool(sessionLog('s1', [delivery, turnStart(1)]))
    assert.deepEqual(result, { suppressed: true })
    h.push(turnEndFrame('s1', 10, 1))
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
    h.push(turnEndFrame('s1', 10, 1))
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
    await h.callTool(sessionLog('s1', [delivery, turnStart(1)]))
    h.push(turnEndFrame('s1', 10, 1, 'error'))
    await settle()
    assert.deepEqual(h.notifies().map((frame) => frame.payload.category), ['session.error'])
  } finally {
    h.bridge.dispose()
  }
})

test('请求静默之后用户插话：撤销静默，照常通知；更早的用户消息不撤销', async () => {
  const h = harness()
  try {
    const session = sessionLog('s1', [delivery, turnStart(1)])
    await h.callTool(session)
    h.push(userMessageFrame('s1', 0, 'user'))
    h.push(turnEndFrame('s1', 10, 1))
    await settle()
    assert.equal(h.notifies().length, 0, '日志位置早于静默请求的用户消息不撤销')

    const next = sessionLog('s2', [delivery, turnStart(1)])
    await h.callTool(next)
    h.push(userMessageFrame('s2', 5, 'user'))
    h.push(turnEndFrame('s2', 10, 1))
    await settle()
    assert.deepEqual(h.notifies().map((frame) => frame.payload.sessionId), ['s2'])
  } finally {
    h.bridge.dispose()
  }
})

test('普通轮次或任务变更提示的轮次调用工具：返回 suppressed=false，照常通知', async () => {
  const h = harness()
  try {
    const plain = await h.callTool(sessionLog('s1', [userPrompt, turnStart(1)]))
    assert.equal(plain.suppressed, false)
    assert.match(plain.note ?? '', /not started by a scheduled task/)
    const notice = await h.callTool(sessionLog('s2', [userPrompt, changeNotice, turnStart(1)]))
    assert.equal(notice.suppressed, false)
    h.push(turnEndFrame('s1', 10, 1))
    h.push(turnEndFrame('s2', 10, 1))
    await settle()
    assert.equal(h.notifies().length, 2)
  } finally {
    h.bridge.dispose()
  }
})

test('静默只作用于本轮：迟到的上一轮 turn.end 不消费，下一轮默认通知', async () => {
  const h = harness()
  try {
    await h.callTool(sessionLog('s1', [delivery, turnStart(1), delivery, turnStart(2)]))
    h.push(turnEndFrame('s1', 3, 1))
    h.push(turnEndFrame('s1', 9, 2))
    h.push(turnEndFrame('s1', 15, 3))
    await settle()
    assert.deepEqual(h.notifies().length, 2, '第 1 轮（迟到）与第 3 轮通知，第 2 轮静默')
  } finally {
    h.bridge.dispose()
  }
})

test('静默轮次中的审批照常通知，只跳过完成通知', async () => {
  const h = harness()
  try {
    await h.callTool(sessionLog('s1', [delivery, turnStart(1)]))
    h.push({ type: 'approval/requested', rpcId: 'ap-1', sessionId: 's1', approvalId: 'a1', toolName: 'bash', reason: 'rm -rf build' } as MuxFrameLike)
    h.push(turnEndFrame('s1', 10, 1))
    await settle()
    assert.deepEqual(h.notifies().map((frame) => frame.payload.category), ['approval.required'])
  } finally {
    h.bridge.dispose()
  }
})

test('轮次号缺失时按日志位置判定', () => {
  const tracker = new QuietCompletionTracker()
  tracker.requestQuiet('s1', { scheduled: true }, 5)
  assert.equal(tracker.consumeTurnEnd('s1', true, undefined, 3), false, '更早的 turn.end')
  assert.equal(tracker.consumeTurnEnd('s1', true, undefined, 8), true)
  assert.equal(tracker.consumeTurnEnd('s1', true, undefined, 9), false, '已消费')
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

test('工具定义：参数 schema、reason 截断、日志不打原文与渲染文案', async () => {
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
  await tool.execute({ reason: 'x'.repeat(500) }, { agent: { session: sessionLog('s1', [delivery, turnStart(1)]) } })
  assert.match(logs[0], new RegExp(`suppressed=true reasonChars=${MAX_QUIET_REASON_CHARS}$`))
  assert.ok(!logs[0].includes('xxx'), '日志不打 reason 原文')
  const orphan = await tool.execute({ reason: 'n' }, {})
  assert.equal(orphan.suppressed, false, '拿不到会话时不静默')
  assert.match(tool.output.render({}, { suppressed: true })[0].text, /will not be sent/)
  assert.match(tool.output.render({}, { suppressed: false, note: 'n' })[0].text, /^n$/)
})
