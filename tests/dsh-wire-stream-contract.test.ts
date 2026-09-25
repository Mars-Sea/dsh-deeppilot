import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { DshApiProxy } from '../src/dsh-api-proxy.ts'
import { inProcessRemoteRequest } from '../src/dsh-remote-interactions.ts'

/** The rc.2 Gateway requires the cancellation signal in argument five. */

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
async function openMuxOnce(gateway: unknown): Promise<HostBinding> {
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

test('the rc.2 Host receives the cancellation signal as its fifth argument', async () => {
  const binding = await openMuxOnce(rc1Gateway([]))

  assert.equal(binding.endpoint, '$events')
  assert.deepEqual(binding.payload, { args: {} })
  assert.equal(binding.args.length, 5, 'a 5-arity Host must be called with five arguments')
  assert.equal(binding.signalSlot, 4, 'the AbortSignal must occupy the 0.1.7 signal parameter')
  assert.equal(binding.uplink, undefined, 'the in-process carrier publishes no uplink')
  assert.equal(binding.peer, undefined, 'the in-process carrier speaks for the operator')
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
