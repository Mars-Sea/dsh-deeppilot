import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { DshApiProxy } from '../src/dsh-api-proxy.ts'
import {
  inProcessRemoteRequest,
  type HostPeerLike,
} from '../src/dsh-remote-interactions.ts'

/** The Host requires a Peer in argument four and the cancellation signal in five. */

/** One Peer in the shape the Host hands to every carrier call. */
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

function hostGateway(bindings: HostBinding[]) {
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

test('the Host receives a fresh owner/answer Peer on the carrier call', async () => {
  const requests: unknown[] = []
  const created = hostPeer()
  const binding = await openMuxOnce(hostGateway([]), {
    createPeer: (options: unknown) => {
      requests.push(options)
      return created
    },
  })

  // Without `interactions: 'answer'` the Gateway refuses `$events` outright
  // (`gateway/interactions-forbidden`), and without an owner principal it
  // refuses a forwarded Remote event result.
  assert.deepEqual(requests, [{ principal: { kind: 'owner' }, interactions: 'answer' }],
    'the resident Client must ask for an owner Peer that may answer')
  assert.equal(binding.peer, created, 'the created Peer must reach wireStream.open')
  assert.equal(binding.signalSlot, 4, 'the signal keeps the fifth slot')
})

test('resident Client Fetch accepts a relative RPC path', async () => {
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
