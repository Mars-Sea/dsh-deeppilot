import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { DshApiProxy } from '../src/dsh-api-proxy.ts'
import {
  adoptClientModule,
  installResidentConnection,
  inProcessRemoteRequest,
  type HostPeerLike,
} from '../src/dsh-remote-interactions.ts'

/** alpha.3 requires a Peer in argument four and the cancellation signal in five. */

/** One Peer in the shape alpha.3 hands to every carrier call. */
function hostPeer(): HostPeerLike {
  return { principal: { kind: 'owner' }, signal: new AbortController().signal, interactions: 'answer' }
}

interface HostBinding {
  endpoint: unknown
  payload: unknown
  /** Arguments the Host `open` was actually called with, in order. */
  args: unknown[]
  /** Index of the AbortSignal inside `args`, or -1 when the Host got none. */
  signalSlot: number
  uplink: unknown
  peer: unknown
}

function hostBinding(args: unknown[]): HostBinding {
  const signalSlot = args.findIndex(argument => argument instanceof AbortSignal)
  return {
    endpoint: args[0],
    payload: args[1],
    args,
    signalSlot,
    uplink: args[2],
    peer: args[3],
  }
}

/** Mirrors the Host `$events` stream: one ready frame, then open until aborted. */
async function* eventsStream(signal: AbortSignal): AsyncIterable<unknown> {
  yield { type: 'ready', clientId: 'deeppilot-client', host: { home: '/tmp/home' } }
  if (signal.aborted) return
  await new Promise<void>(resolve => signal.addEventListener('abort', () => { resolve() }, { once: true }))
}

function rc1Gateway(bindings: HostBinding[]) {
  return {
    wireStream: {
      open: (
        endpoint: string,
        payload: unknown,
        uplink: unknown,
        peer: unknown,
        signal: AbortSignal,
      ): Promise<AsyncIterable<unknown>> => {
        bindings.push(hostBinding([endpoint, payload, uplink, peer, signal]))
        return Promise.resolve(eventsStream(signal))
      },
    },
  }
}

/** Pull the events mux once and return the binding the Host `open` observed. */
async function openMuxOnce(
  gateway: unknown,
  connectionOverrides: Record<string, unknown> = {},
): Promise<HostBinding> {
  const bindings: HostBinding[] = []
  const target = gateway as { wireStream: { open: (...args: never[]) => unknown } }
  const hostOpen = target.wireStream.open
  // Record the call as the Host receives it, before the stand-in narrows it.
  const recorder = ((...args: unknown[]) => {
    bindings.push(hostBinding(args))
    return (hostOpen as (...a: unknown[]) => unknown)(...args)
  }) as { (...args: unknown[]): unknown; length: number }
  target.wireStream.open = recorder as never

  const ctx = new Context()
  ctx.provide('sessionController', {})
  ctx.provide('connection', {
    createSharedFetchHandler: () => ({
      fetch: async () => Response.json({ type: 'server-response', rpcId: 'rpc', result: { ok: true } }),
    }),
    ...connectionOverrides,
  })
  ctx.provide('typertGateway', gateway)

  const proxy = new DshApiProxy(ctx as never)
  const controller = new AbortController()
  const iterator = proxy.events.mux({}, controller.signal)[Symbol.asyncIterator]()
  // The events mux starts the resident Client, which opens `$events` at once.
  const pending = iterator.next()
  for (let attempt = 0; attempt < 400 && bindings.length === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  controller.abort()
  await pending.catch(() => undefined)
  await iterator.return?.()

  assert.equal(bindings.length, 1, 'the resident Client must open exactly one Host stream')
  return bindings[0]!
}

test('a Host without createPeer receives its own operator Peer', async () => {
  const operator = hostPeer()
  const binding = await openMuxOnce(rc1Gateway([]), { operator })

  assert.equal(binding.endpoint, '$events')
  assert.deepEqual(binding.payload, { args: {} })
  assert.equal(binding.args.length, 5, 'a 5-arity Host must be called with five arguments')
  assert.equal(binding.signalSlot, 4, 'the AbortSignal must occupy the 0.1.7 signal parameter')
  assert.equal(binding.uplink, undefined, 'the in-process carrier publishes no uplink')
  assert.equal(binding.peer, operator, 'a Host that defaults an absent Peer still gets a live one')
})

test('an alpha.3 Host receives a fresh owner/answer Peer on the carrier call', async () => {
  const requests: unknown[] = []
  const created = hostPeer()
  const binding = await openMuxOnce(rc1Gateway([]), {
    createPeer: (options: unknown) => {
      requests.push(options)
      return created
    },
  })

  // Without `interactions: 'answer'` the Gateway refuses `$events` outright
  // (`gateway/interactions-forbidden`), and without an owner principal it
  // refuses a forwarded Remote event result. Both are alpha.3 requirements.
  assert.deepEqual(requests, [{ principal: { kind: 'owner' }, interactions: 'answer' }],
    'the resident Client must ask for an owner Peer that may answer')
  assert.equal(binding.peer, created, 'the created Peer must reach wireStream.open')
  assert.equal(binding.signalSlot, 4, 'the signal keeps the fifth slot')
})

test('the explicit installer names the participation alpha.3 requires', () => {
  const installed: unknown[] = []
  const transport = {
    fetch: async () => new Response(),
    openStream: () => (async function* () { })(),
    ownsHost: true as const,
  }
  installResidentConnection(
    {
      apply: () => { throw new Error('apply must not run while the explicit installer exists') },
      installConnection: (_ctx: Context, options: unknown) => { installed.push(options) },
    } as never,
    new Context(),
    transport,
  )

  assert.deepEqual(installed, [{ transport, interactions: 'answer' }],
    'apply() alone would select interactions=none for a caller with no page location')
})

test('a Host older than the explicit installer falls back to apply', () => {
  let applied = 0
  installResidentConnection(
    { apply: () => { applied += 1 } } as never,
    new Context(),
    { fetch: async () => new Response(), openStream: () => (async function* () { })(), ownsHost: true },
  )

  assert.equal(applied, 1, 'the carrier still arrives through the process global apply() reads')
})

test('a Node bundle namespace registers when the browser banner did not fire', () => {
  const modules = new Map<string, unknown>()
  const face = { apply: () => undefined }
  adoptClientModule(modules, '@deepseek-ai/dsh-client-connection/client', face)

  assert.equal(modules.get('@deepseek-ai/dsh-client-connection'), face,
    'alpha.3 ships a node bundle that exports the face instead of registering the banner')
})

test('a banner registration outranks the Node bundle namespace', () => {
  const modules = new Map<string, unknown>([['@deepseek-ai/dsh-api-gateway', 'from-banner']])
  adoptClientModule(modules, '@deepseek-ai/dsh-api-gateway/client', { apply: () => undefined })

  assert.equal(modules.get('@deepseek-ai/dsh-api-gateway'), 'from-banner',
    'the bundle\'s own internal require() resolves through the banner exports')
})

test('resident Client Fetch accepts the rc.2 relative RPC path', async () => {
  const body = JSON.stringify({ method: '$events/result' })
  const request = inProcessRemoteRequest('api/$events/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  assert.equal(new URL(request.url).pathname, '/api/$events/result')
  assert.equal(request.method, 'POST')
  assert.equal(await request.text(), body)
})
