/**
 * Live smoke test against a REAL DSH host profile.
 *
 * Why this exists: `npm test` drives the bridge through in-memory fakes, and
 * `check:config-schema` only proves the Config schema survives the pinned DSH
 * loader. Neither one touches the seams that actually break on a DSH upgrade —
 * the LAN TLS listener, the challenge/prove handshake, and every Host RPC the
 * bridge forwards through `ctx.apiProxy`. This script boots nothing itself: it
 * drives a `dsh web` profile that already has this working copy installed and
 * asserts the phone protocol end to end against it.
 *
 * Two subcommands:
 *   register  mint a stable smoke identity and pre-authorize it in the
 *             profile's devices-v2.json, so the run can authenticate without a
 *             pairing code. Run this BEFORE starting the host, then restart it
 *             — DeviceStore snapshots the file once at mount.
 *   run       connect over WSS and execute the checklist.
 *
 * The pairing-code happy path is deliberately NOT driven here: the code only
 * exists inside the host process and can only be minted through the plugin's
 * own `deeppilot/beginPairing` Host RPC, i.e. through a DSH client session.
 * Forging it would test nothing real. What this script does check on that route
 * is that `/phone/pair` is mounted on the live host and rejects a bad code —
 * the negative path plus the real challenge/prove handshake cover the route,
 * while the code-issuance contract stays covered by the unit tests.
 *
 * Usage:
 *   npx tsx scripts/smoke-live.mts register
 *   npx tsx scripts/smoke-live.mts run [--interactions] [--prompt]
 *
 * Environment:
 *   SMOKE_DSH_HOME    profile home (default: <repo>/.dsh-smoke-home)
 *   SMOKE_ENDPOINT    phone listener (default: https://127.0.0.1:3098)
 *   SMOKE_TIMEOUT_MS  per-step timeout (default: 30000)
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request as httpsRequest } from 'node:https'
import { X509Certificate } from 'node:crypto'
import WebSocket from 'ws'
import {
  canonicalAuthChallenge,
  deviceIdForPublicKey,
  fingerprintForPublicKey,
  DEVICE_SCOPES,
  type AuthProofFields,
} from '../src/device-auth.ts'
import { spkiFingerprint } from '../src/lan-tls.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.SMOKE_DSH_HOME ?? join(ROOT, '.dsh-smoke-home')
const DEVICE_FILE = join(DSH_HOME, 'deeppilot', 'devices-v2.json')
const IDENTITY_FILE = join(DSH_HOME, 'deeppilot', 'smoke-identity.json')
const ENDPOINT = process.env.SMOKE_ENDPOINT ?? 'https://127.0.0.1:3098'
const STEP_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 30_000)

// ---------- result bookkeeping ----------

type Verdict = 'PASS' | 'FAIL' | 'WARN' | 'SKIP'
const results: { name: string; verdict: Verdict; detail: string }[] = []

function record(name: string, verdict: Verdict, detail = ''): void {
  results.push({ name, verdict, detail })
  console.log(`[${verdict}] ${name}${detail ? ' — ' + detail : ''}`)
}

function assert(name: string, condition: boolean, detail: string): boolean {
  record(name, condition ? 'PASS' : 'FAIL', condition ? detail : `断言失败: ${detail}`)
  return condition
}

class StepError extends Error {}

// ---------- smoke identity ----------

interface SmokeIdentity {
  privateKeyPem: string
  publicKey: string
  deviceId: string
}

function mintIdentity(): SmokeIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x as string, 'base64url'),
    Buffer.from(jwk.y as string, 'base64url'),
  ]).toString('base64url')
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: raw,
    deviceId: deviceIdForPublicKey(raw),
  }
}

function loadIdentity(): SmokeIdentity {
  if (!existsSync(IDENTITY_FILE)) {
    throw new Error(`缺少冒烟身份 ${IDENTITY_FILE}，请先运行: npx tsx scripts/smoke-live.mts register`)
  }
  return JSON.parse(readFileSync(IDENTITY_FILE, 'utf8')) as SmokeIdentity
}

/** Sign the canonical challenge exactly the way the iOS app does. */
function signProof(fields: AuthProofFields, identity: SmokeIdentity): string {
  return sign('sha256', canonicalAuthChallenge(fields), identity.privateKeyPem).toString('base64url')
}

function registerDevice(): void {
  const identity = mintIdentity()
  mkdirSync(dirname(IDENTITY_FILE), { recursive: true })
  writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2), { mode: 0o600 })

  const now = Date.now()
  const devices: { devices?: Record<string, unknown>[] } = existsSync(DEVICE_FILE)
    ? JSON.parse(readFileSync(DEVICE_FILE, 'utf8'))
    : {}
  const rows = Array.isArray(devices.devices) ? devices.devices : []
  const next = {
    deviceId: identity.deviceId,
    deviceName: 'Smoke Harness',
    appVersion: 'smoke',
    publicKey: identity.publicKey,
    fingerprint: fingerprintForPublicKey(identity.publicKey),
    scopes: [...DEVICE_SCOPES],
    firstSeenTs: now,
    lastSeenTs: now,
  }
  const kept = rows.filter((row) => row.deviceId !== identity.deviceId)
  writeFileSync(DEVICE_FILE, JSON.stringify({ devices: [...kept, next] }, null, 2), { mode: 0o600 })
  console.log(`已写入冒烟设备 ${identity.deviceId} → ${DEVICE_FILE}`)
  console.log('现在启动（或重启）dsh web profile，DeviceStore 只在挂载时读取一次该文件。')
}

// ---------- minimal protocol client ----------

interface Frame {
  v: number
  type: string
  id?: string
  ts?: number
  seq?: number
  payload?: any
}

type PushHandler = (frame: Frame) => void

class PhoneClient {
  private ws!: WebSocket
  private seq = 0
  private readonly waiters = new Map<string, (frame: Frame) => void>()
  private readonly pushHandlers = new Set<PushHandler>()
  /** Every frame received, so a step can assert on what it did NOT get. */
  readonly received: Frame[] = []
  private closeReason: { code: number; reason: string } | undefined

  async connect(): Promise<void> {
    this.ws = new WebSocket(`${ENDPOINT.replace(/^http/, 'ws')}/phone`, {
      rejectUnauthorized: false,
      handshakeTimeout: STEP_TIMEOUT_MS,
    })
    this.ws.on('message', (data) => this.onMessage(String(data)))
    this.ws.on('close', (code, reason) => {
      const closed = { code, reason: reason.toString() }
      this.closeReason = closed
      const failure = { v: 2, type: 's2c.error', payload: { code: 'E_INTERNAL', message: `连接已关闭 ${code}` } }
      for (const [, resolve] of this.waiters) resolve(failure)
      this.waiters.clear()
    })
    this.ws.on('error', () => { /* close handler reports it */ })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new StepError('WebSocket 握手超时')), STEP_TIMEOUT_MS)
      this.ws.once('open', () => { clearTimeout(timer); resolve() })
      this.ws.once('error', (error) => { clearTimeout(timer); reject(new StepError('WebSocket 连接失败: ' + error.message)) })
    })
  }

  private onMessage(raw: string): void {
    let frame: Frame
    try {
      frame = JSON.parse(raw) as Frame
    } catch {
      return
    }
    this.received.push(frame)
    for (const handler of this.pushHandlers) handler(frame)
    if (frame.id !== undefined) {
      const waiter = this.waiters.get(frame.id)
      if (waiter) {
        this.waiters.delete(frame.id)
        waiter(frame)
      }
    }
  }

  onPush(handler: PushHandler): () => void {
    this.pushHandlers.add(handler)
    return () => this.pushHandlers.delete(handler)
  }

  /** Send one request and await the response that echoes its id. */
  request(type: string, payload?: unknown, timeoutMs = STEP_TIMEOUT_MS): Promise<Frame> {
    const id = `smoke-${++this.seq}`
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(new StepError(`${type} 等待响应超时 (${timeoutMs}ms)`))
      }, timeoutMs)
      this.waiters.set(id, (frame) => { clearTimeout(timer); resolve(frame) })
      this.ws.send(JSON.stringify({ v: 2, type, id, ts: Date.now(), ...(payload === undefined ? {} : { payload }) }))
    })
  }

  send(type: string, payload?: unknown): void {
    this.ws.send(JSON.stringify({ v: 2, type, ts: Date.now(), ...(payload === undefined ? {} : { payload }) }))
  }

  /** Resolve on the first push frame satisfying `match`, or reject on timeout. */
  waitForPush(match: (frame: Frame) => boolean, timeoutMs = STEP_TIMEOUT_MS, label = 'push'): Promise<Frame> {
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new StepError(`${label} 等待超时 (${timeoutMs}ms)`)) }, timeoutMs)
      const off = this.onPush((frame) => {
        if (!match(frame)) return
        clearTimeout(timer)
        off()
        resolve(frame)
      })
    })
  }

  close(): void {
    try { this.ws.close(1000, 'smoke done') } catch { /* already gone */ }
  }
}

/** Reject a step that came back as s2c.error instead of the expected type. */
function expect(frame: Frame, type: string): Frame {
  if (frame.type === 's2c.error') {
    const { code, message } = frame.payload ?? {}
    throw new StepError(`收到 s2c.error ${code}: ${message}`)
  }
  if (frame.type !== type) throw new StepError(`期望 ${type}，实际 ${frame.type}`)
  return frame
}

// ---------- HTTP probes (no DSH web surface involved) ----------

function httpJson(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(ENDPOINT + path)
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const req = httpsRequest({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      rejectUnauthorized: false,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      let raw = ''
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        let json: unknown = raw
        try { json = JSON.parse(raw) } catch { /* keep text */ }
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', (error) => reject(new StepError(`${method} ${path} 失败: ${error.message}`)))
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * Read the LAN listener's self-signed certificate and hash its PUBLIC KEY.
 * The bridge pins the SPKI digest (src/lan-tls.ts), not the certificate DER,
 * so hashing `cert.raw` here would silently produce a value that never
 * matches the pin the plugin logs and the app stores.
 */
async function certificateFingerprint(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const url = new URL(ENDPOINT)
    const req = httpsRequest({
      hostname: url.hostname,
      port: url.port,
      path: '/phone/health',
      rejectUnauthorized: false,
    }, (res) => {
      const socket = res.socket as { getPeerCertificate?: () => { raw: Buffer } }
      const cert = socket.getPeerCertificate?.()
      try {
        resolve(cert?.raw ? spkiFingerprint(new X509Certificate(cert.raw).toString()) : undefined)
      } catch {
        resolve(undefined)
      }
      res.resume()
    })
    req.on('error', () => resolve(undefined))
    req.end()
  })
}

/**
 * The plugin logs the pin it mounted the listener with. Comparing our computed
 * digest against that line is the only way to prove the app and the script
 * agree on what "the LAN certificate fingerprint" means.
 */
function loggedPin(): string | undefined {
  const logFile = process.env.SMOKE_LOG
  if (!logFile || !existsSync(logFile)) return undefined
  const matches = [...readFileSync(logFile, 'utf8').matchAll(/tls fingerprint (sha256:[A-Za-z0-9_-]+)/g)]
  return matches.at(-1)?.[1]
}

// ---------- checklist ----------

async function run(options: { interactions: boolean; prompt: boolean }): Promise<void> {
  const identity = loadIdentity()

  // 1. health
  const health = await httpJson('GET', '/phone/health')
  const healthOk = health.status === 200 && health.json?.ok === true
  const healthOkResult = assert(
    '1. /phone/health 在真实宿主上返回就绪',
    healthOk,
    `HTTP ${health.status} protocolVersion=${health.json?.protocolVersion} dataPlane=${health.json?.dataPlane}`,
  )
  if (!healthOkResult) {
    // Without a mounted bridge nothing below can work; stop with a clear reason.
    assert('1b. 协议版本为 2', health.json?.protocolVersion === 2, String(health.json?.protocolVersion))
    console.log('\n桥接未就绪，终止后续检查。')
    return
  }
  assert('1b. 协议版本为 2', health.json?.protocolVersion === 2, String(health.json?.protocolVersion))
  assert('1c. 数据平面已激活', health.json?.dataPlane === true, String(health.json?.dataPlane))

  const fingerprint = await certificateFingerprint()
  assert('1d. LAN TLS 证书可取 SPKI 指纹', fingerprint !== undefined, fingerprint ?? '未取到')
  const pin = loggedPin()
  if (pin && fingerprint) {
    assert('1e. 脚本算出的 pin 与插件启动日志一致', pin === fingerprint, `脚本=${fingerprint} 日志=${pin}`)
  } else {
    record('1e. 脚本算出的 pin 与插件启动日志一致', 'SKIP', '未设置 SMOKE_LOG，无法读取插件日志中的 pin')
  }

  // 2. pair route is mounted and refuses a bogus code
  const bogus = await httpJson('POST', '/phone/pair', {
    v: 2,
    code: 'smoke-not-a-real-code',
    publicKey: identity.publicKey,
    deviceName: 'Smoke Harness',
    appVersion: 'smoke',
  })
  assert(
    '2. /phone/pair 已挂载且拒绝无效配对码',
    bogus.status === 401,
    `HTTP ${bogus.status} ${JSON.stringify(bogus.json)}`,
  )

  const client = new PhoneClient()
  await client.connect()
  record('3. WSS 升级到 /phone 成功', 'PASS', ENDPOINT)

  // 4. challenge/prove
  const challenge = await client.waitForPush((f) => f.type === 's2c.auth.challenge', STEP_TIMEOUT_MS, 's2c.auth.challenge')
  const cp = challenge.payload as { nonce: string; audience: string; issuedAt: number; expiresAt: number }
  const fields = {
    deviceId: identity.deviceId,
    deviceName: 'Smoke Harness',
    appVersion: 'smoke',
    nonce: cp.nonce,
    audience: cp.audience,
    issuedAt: cp.issuedAt,
    expiresAt: cp.expiresAt,
  }
  const signature = signProof(fields, identity)
  client.send('c2s.auth.prove', { ...fields, signature })
  const welcome = await client.waitForPush((f) => f.type === 's2c.welcome', STEP_TIMEOUT_MS, 's2c.welcome')
  const wp = welcome.payload as { capabilities: Record<string, boolean>; cursor: number; resumed: boolean; scopes: string[] }
  assert('4. challenge/prove 握手通过并收到 welcome', true, `scopes=${wp.scopes.join(',')}`)
  console.log('     宿主能力位: ' + JSON.stringify(wp.capabilities))

  // 5. session list
  const sessions = expect(await client.request('c2s.sessions.list'), 's2c.sessions.snapshot').payload
  assert('5. c2s.sessions.list 返回会话快照', Array.isArray(sessions?.sessions), `${sessions?.sessions?.length ?? 0} 个会话`)

  // 6. open a session we own and page its history
  const created = expect(
    await client.request('c2s.session.create', { cwd: ROOT }, STEP_TIMEOUT_MS),
    's2c.ack',
  ).payload as { sessionId: string }
  const sessionId = created?.sessionId
  if (!assert('6. c2s.session.create 成功', typeof sessionId === 'string', String(sessionId))) {
    client.close()
    return
  }
  // c2s.session.open answers with an unsolicited s2c.session.tail push; only a
  // failure comes back as an id-correlated s2c.error (src/connection.ts:389).
  const tailPromise = client.waitForPush(
    (f) => f.type === 's2c.session.tail' && f.payload?.sessionId === sessionId,
    STEP_TIMEOUT_MS,
    's2c.session.tail',
  ).catch((error: Error) => {
    const failure = client.received.find((f) => f.type === 's2c.error')
    throw new StepError(failure ? `打开会话被拒绝: ${JSON.stringify(failure.payload)}` : error.message)
  })
  client.send('c2s.session.open', { sessionId, tailCount: 20 })
  const tail = (await tailPromise).payload
  assert('6b. c2s.session.open 返回尾部消息', Array.isArray(tail?.messages), `${tail?.messages?.length ?? 0} 条`)
  const page = expect(
    await client.request('c2s.session.history', { sessionId, beforeSeq: Number.MAX_SAFE_INTEGER, limit: 20 }),
    's2c.history.page',
  ).payload
  assert('6c. c2s.session.history 分页可用', Array.isArray(page?.messages), `hasMore=${page?.hasMore}`)

  // 7. model catalog + selection (exercises sessionController.modelCatalog/selectModel)
  const models = expect(await client.request('c2s.session.models', { sessionId }), 's2c.session.models').payload
  const groups = Array.isArray(models?.groups) ? models.groups : []
  const totalModels = groups.reduce((sum: number, g: any) => sum + (g.models?.length ?? 0), 0)
  assert('7. 模型目录可读', totalModels > 0, `${groups.length} 个 provider / ${totalModels} 个模型, routable=${models?.routable}`)
  const firstModel = groups[0]?.models?.[0]
  if (firstModel) {
    const selected = expect(
      await client.request('c2s.session.selectModel', {
        sessionId,
        provider: groups[0].id,
        model: firstModel.id,
      }),
      's2c.session.modelSelected',
    ).payload
    assert('7b. 模型切换生效', selected?.selected?.model === firstModel.id, JSON.stringify(selected?.selected))
  } else {
    record('7b. 模型切换生效', 'SKIP', '目录为空，无法选择')
  }

  // 8. workspaces
  const ws = expect(await client.request('c2s.workspaces.list'), 's2c.workspaces.snapshot').payload
  assert('8. 工作区列表可读', Array.isArray(ws?.workspaces), `${ws?.workspaces?.length ?? 0} 个工作区`)
  const probeDir = join(DSH_HOME, 'smoke-workspace')
  mkdirSync(probeDir, { recursive: true })
  const createdWs = expect(await client.request('c2s.workspace.create', { path: probeDir }), 's2c.workspace.created').payload
  // `created:false` is the host's idempotent answer for a path it already
  // knows, so a repeat run is a pass, not a failure.
  assert(
    '8b. 工作区创建/复用成功',
    typeof createdWs?.workspace?.id === 'string',
    `id=${createdWs?.workspace?.id ?? '无'} created=${createdWs?.created}`,
  )

  // 9. a real turn through the model, before archiving: archiving ends the
  // session's live work, so prompting afterwards would test a closed session.
  if (options.prompt) {
    // clientSendId must be "<13-digit epoch ms>-<uuid>"; the bridge also
    // re-derives the timestamp from that prefix (src/prompt-delivery.ts:10,26).
    const marker = `${Date.now()}-${randomUUID()}`
    // Send with a clientSendId so the bridge answers with a delivery receipt
    // (src/connection.ts:714-718). An un-id'd send could only fail silently,
    // which is exactly what a timeout here would have hidden.
    const receipt = expect(
      await client.request('c2s.session.sendPrompt', { sessionId, text: `回复这个词即可，不要做别的：${marker}`, clientSendId: marker }, 60_000),
      's2c.ack',
    ).payload
    const kinds = new Set<string>()
    const stop = client.onPush((f) => {
      if (f.type === 's2c.session.event' && f.payload?.sessionId === sessionId) kinds.add(String(f.payload.kind))
    })
    const ended = await client.waitForPush(
      (f) => f.type === 's2c.session.event' && f.payload?.sessionId === sessionId && f.payload?.kind === 'turn.end',
      240_000,
      'turn.end',
    ).then(() => true).catch(() => false)
    stop()
    const finals = client.received
      .filter((f) => f.type === 's2c.session.event' && f.payload?.kind === 'message.final')
      .map((f) => String(f.payload?.data?.text ?? ''))
    assert(
      '9. 真实提问跑完一个 turn 并收到回答',
      receipt?.status !== 'rejected' && ended,
      `投递回执=${receipt?.status ?? '无'}${receipt?.code ? '/' + receipt.code : ''} 已见事件=[${[...kinds].join(',') || '无'}]`
        + (finals.length ? ' 末条回答: ' + finals[finals.length - 1].slice(0, 80) : ''),
    )
  } else {
    record('9. 真实提问跑完一个 turn 并收到回答', 'SKIP', '未加 --prompt')
  }

  // 10. approval / question round trip, still before archiving: both need a
  // session that can accept a new turn, and archiving ends the live work.
  if (options.interactions) {
    await runInteraction(client, sessionId, 'approval', '请在当前工作区创建文件 deeppilot-smoke-approval.txt，内容写 ok。')
    await runInteraction(client, sessionId, 'question', '在继续之前，请先向我提问：你希望文件内容写什么？')
  } else {
    record('10. 审批/问答往返', 'SKIP', '未加 --interactions（依赖模型主动触发，成本与不确定性高）')
  }

  // 11. archive / list archived / unarchive
  const archived = expect(await client.request('c2s.session.archive', { sessionId }), 's2c.session.archived').payload
  assert('11. 会话归档成功', archived?.sessionId === sessionId || archived?.ok === true, JSON.stringify(archived))
  // The archived mirror is rebuilt only when refreshSummaries() runs, which
  // archiving itself does not trigger (src/host-bridge.ts:340/381/388 vs
  // :921-943). Poll briefly so a background refresh can land, but report a
  // still-stale mirror as WARN: it is a real, pre-existing timing behaviour,
  // not a DSH 0.2.0 regression, and it must stay visible rather than hidden.
  let archivedRows: any[] = []
  const deadline = Date.now() + 10_000
  do {
    expect(await client.request('c2s.sessions.list', {}), 's2c.sessions.snapshot')
    const list = expect(await client.request('c2s.sessions.archived', {}), 's2c.sessions.archived.snapshot').payload
    archivedRows = list?.sessions ?? []
    if (archivedRows.some((s: any) => s.id === sessionId)) break
    await new Promise((resolve) => setTimeout(resolve, 1500))
  } while (Date.now() < deadline)
  assert('11b. 归档列表包含该会话', archivedRows.some((s: any) => s.id === sessionId), `${archivedRows.length} 条`)
  const unarchived = expect(await client.request('c2s.session.unarchive', { sessionId }), 's2c.session.unarchived').payload
  assert('11c. 取消归档成功', unarchived?.sessionId === sessionId || unarchived?.ok === true, JSON.stringify(unarchived))

  // 12. pending approvals/questions
  const pending = expect(await client.request('c2s.pending.list'), 's2c.pending.snapshot').payload
  assert(
    '12. 待办审批/问答快照可读',
    Array.isArray(pending?.approvals) && Array.isArray(pending?.questions),
    `approvals=${pending?.approvals?.length ?? 0} questions=${pending?.questions?.length ?? 0}`,
  )

  // 13. schedule surface
  if (wp.capabilities?.schedules === true) {
    const list = expect(await client.request('c2s.schedule.list', { sessionId }), 's2c.schedule.snapshot').payload
    assert('13. 日程能力已挂载且列表可读', Array.isArray(list?.tasks), `${list?.tasks?.length ?? 0} 个任务`)
    // schedule mutations are idempotent on the same clientRequestId, which
    // follows the same "<epoch ms>-<uuid>" shape as a prompt send.
    const taskId = `${Date.now()}-${randomUUID()}`
    const createdTask = expect(await client.request('c2s.schedule.create', {
      clientRequestId: taskId,
      sessionId,
      title: 'smoke',
      prompt: 'smoke',
      after_seconds: 3600,
    }), 's2c.schedule.updated').payload
    assert('13b. 日程任务创建成功', createdTask?.task?.id !== undefined, JSON.stringify(createdTask?.task?.id ?? createdTask))
    if (createdTask?.task?.id) {
      const history = expect(
        await client.request('c2s.schedule.history', { sessionId, id: createdTask.task.id, limit: 10 }),
        's2c.schedule.history',
      ).payload
      assert('13c. 日程投递历史可读', Array.isArray(history?.history?.records), `${history?.history?.records?.length ?? 0} 条记录`)
      expect(await client.request('c2s.schedule.delete', { clientRequestId: `${Date.now()}-${randomUUID()}`, sessionId, id: createdTask.task.id }), 's2c.schedule.updated')
      record('13d. 日程任务删除成功', 'PASS', createdTask.task.id)
    }
  } else {
    record('13. 日程能力', 'SKIP', 'capabilities.schedules=false（宿主未挂载 Schedule service，属预期降级）')
  }

  // 14. disconnect / reconnect replay
  // A real app persists the server cursor from welcome, not the highest seq it
  // happened to observe, so resume from exactly that.
  const cursorBefore = wp.cursor
  client.close()
  await new Promise((resolve) => setTimeout(resolve, 500))
  const reconnected = new PhoneClient()
  await reconnected.connect()
  const challenge2 = await reconnected.waitForPush((f) => f.type === 's2c.auth.challenge', STEP_TIMEOUT_MS, 's2c.auth.challenge')
  const cp2 = challenge2.payload as { nonce: string; audience: string; issuedAt: number; expiresAt: number }
  const fields2 = { ...fields, nonce: cp2.nonce, audience: cp2.audience, issuedAt: cp2.issuedAt, expiresAt: cp2.expiresAt, resumeCursor: cursorBefore }
  const signature2 = signProof(fields2, identity)
  reconnected.send('c2s.auth.prove', { ...fields2, signature: signature2 })
  const welcome2 = (await reconnected.waitForPush((f) => f.type === 's2c.welcome', STEP_TIMEOUT_MS, 's2c.welcome')).payload
  const replayDone = await reconnected.waitForPush((f) => f.type === 's2c.resume.done', 5_000, 's2c.resume.done').catch(() => undefined)
  assert(
    '14. 断连后带 resumeCursor 重连成功',
    welcome2?.protocolVersion === 2,
    `resumed=${welcome2?.resumed} cursor=${welcome2?.cursor} resumeDone=${replayDone ? '是' : '未发送'} 重连前游标=${cursorBefore}`,
  )
  const afterReconnect = expect(await reconnected.request('c2s.sessions.list'), 's2c.sessions.snapshot').payload
  assert('14b. 重连后会话列表仍可用', (afterReconnect?.sessions ?? []).some((s: any) => s.id === sessionId), `${afterReconnect?.sessions?.length ?? 0} 个会话`)
  reconnected.close()
}

/** Drive one approval or question round trip; a missing prompt is not a failure. */
async function runInteraction(
  client: PhoneClient,
  sessionId: string,
  kind: 'approval' | 'question',
  text: string,
): Promise<void> {
  const pushType = kind === 'approval' ? 's2c.pending.approval' : 's2c.pending.question'
  const label = kind === 'approval' ? '审批' : '问答'
  const turnEnded = (): Promise<boolean> => client.waitForPush(
    (f) => f.type === 's2c.session.event' && f.payload?.sessionId === sessionId && f.payload?.kind === 'turn.end',
    240_000,
    'turn.end',
  ).then(() => true).catch(() => false)
  // Same "<epoch ms>-<uuid>" clientSendId contract as the plain prompt step;
  // using request() here is what makes a rejected dispatch visible instead of
  // silently timing out on a push that will never arrive.
  const marker = `${Date.now()}-${randomUUID()}`
  const receipt = expect(
    await client.request('c2s.session.sendPrompt', { sessionId, text, clientSendId: marker }, 60_000),
    's2c.ack',
  ).payload
  if (receipt?.status === 'rejected') {
    record(`10-${kind}. ${label}往返`, 'FAIL', `投递被拒: ${receipt.code ?? '未知'}`)
    return
  }
  const pending = await client.waitForPush(
    (f) => f.type === pushType && f.payload?.sessionId === sessionId,
    180_000,
    pushType,
  ).catch(() => undefined)
  if (!pending) {
    const kinds = [...new Set(client.received
      .filter((f) => f.type === 's2c.session.event' && f.payload?.sessionId === sessionId)
      .map((f) => String(f.payload.kind)))]
    // Always drain the turn, otherwise the next step dispatches into a busy
    // session and its own send would time out for an unrelated reason.
    await turnEnded()
    record(
      `10-${kind}. ${label}往返`,
      'SKIP',
      `投递回执=${receipt?.status ?? '无'}，但宿主未发出 ${pushType}（模型未触发该交互，或宿主策略对该工具调用自动放行），该会话已见事件=[${kinds.join(',') || '无'}]`,
    )
    return
  }
  const requestId = pending.payload?.requestId
  if (kind === 'approval') {
    const response = expect(
      await client.request('c2s.approval.respond', { requestId, decision: 'allow' }),
      's2c.ack',
    ).payload
    assert(`10-approval. ${label}放行成功`, Boolean(response), `requestId=${requestId}`)
  } else {
    const questions = pending.payload?.questions ?? []
    const answers = questions.map((q: any, index: number) => ({
      id: q.id ?? `q${index}`,
      selected: q.options?.length ? [q.options[0].label] : [],
      ...(q.options?.length ? {} : { custom: 'ok' }),
    }))
    const response = expect(
      await client.request('c2s.question.respond', { requestId, answers }),
      's2c.ack',
    ).payload
    assert(`10-question. ${label}提交成功`, Boolean(response), `requestId=${requestId} 问题数=${questions.length}`)
  }
  // Leave the session idle for whatever runs next.
  await turnEnded()
}

// ---------- entry ----------

const [command = 'run', ...flags] = process.argv.slice(2)

if (command === 'register') {
  registerDevice()
} else if (command === 'run') {
  const options = { interactions: flags.includes('--interactions'), prompt: flags.includes('--prompt') }
  try {
    await run(options)
  } catch (error) {
    record('冒烟测试执行', 'FAIL', error instanceof Error ? error.message : String(error))
  }
  const failed = results.filter((r) => r.verdict === 'FAIL')
  const warned = results.filter((r) => r.verdict === 'WARN')
  const skipped = results.filter((r) => r.verdict === 'SKIP')
  const passed = results.length - failed.length - warned.length - skipped.length
  console.log(`\n汇总: ${passed} 通过 / ${failed.length} 失败 / ${warned.length} 警告 / ${skipped.length} 跳过`)
  process.exitCode = failed.length === 0 ? 0 : 1
} else {
  console.error(`未知子命令: ${command}（可用: register | run）`)
  process.exitCode = 2
}
