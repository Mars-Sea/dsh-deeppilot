/**
 * Resident DSH Remote Events client for phone interactions.
 *
 * The Host-side `approval/request` and `user-questions/request` events are
 * owned once by DSH API Remotes. API Gateway then fans each pending waterfall
 * out to every connected Client and settles the first result. DeepPilot joins
 * that official Client plane in-process instead of registering a competing
 * Host waterfall listener or replacing the official Web composer.
 */
import { Context } from '@deepseek-ai/cordis'

/** Peer used by the in-process Host carrier. */
export interface HostPeerLike {
  readonly principal: { readonly kind: string }
  readonly signal: AbortSignal
  readonly interactions: 'answer' | 'none'
}

interface FetchHandlerLike {
  fetch(request: Request, peer: HostPeerLike): Promise<Response>
}

interface HostConnectionLike {
  createSharedFetchHandler(channel: '/api'): FetchHandlerLike
  createPeer(options: { principal: { kind: 'owner' }; interactions: 'answer' }): HostPeerLike
}

interface HostWireStreamLike {
  open(
    endpoint: string,
    payload: unknown,
    uplink: undefined,
    peer: HostPeerLike,
    signal: AbortSignal,
  ): Promise<AsyncIterable<unknown>>
}

interface HostGatewayLike {
  wireStream: HostWireStreamLike
}

interface ClientTransportHooksLike {
  fetch(input: string, init: RequestInit): Promise<Response>
  openStream(endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown>
  ownsHost: true
}

/** The rc.2 Client sends relative RPC paths to its in-process carrier. */
export function inProcessRemoteRequest(input: string, init: RequestInit): Request {
  // The shared Fetch handler routes by pathname and never performs a network
  // request. Node's Request still requires an absolute URL for relative paths.
  return new Request(new URL(input, 'http://localhost/'), init)
}

interface ClientRemoteLike {
  $on(event: string, listener: (this: Context, request: any, next: () => Promise<unknown>) => unknown): () => void
}

interface ClientTypertLike {
  contexts: {
    registerClient(key: string, adapter: {
      identity(candidate: Context): string | undefined
      resolve(identity: string): Context
    }): () => void
  }
}

interface ClientPluginModule {
  apply(ctx: Context): void
}

interface ClientConnectionModule {
  installConnection(ctx: Context, options: { transport: ClientTransportHooksLike; interactions: 'answer' }): void
}

export interface RemoteApprovalRequest {
  toolName?: string
  callId?: string
  reason?: string
  signal?: AbortSignal
}

export interface RemoteQuestionRequest {
  questions?: unknown
  signal?: AbortSignal
}

export interface DshRemoteInteractionHandlers {
  approval(sessionId: string, request: RemoteApprovalRequest, next: () => Promise<unknown>): unknown
  question(sessionId: string, request: RemoteQuestionRequest, next: () => Promise<unknown>): unknown
}

interface ClientFaces {
  typert: ClientPluginModule
  connection: ClientConnectionModule
  gateway: ClientPluginModule
}

let clientFaces: Promise<ClientFaces> | undefined

function loadClientFaces(): Promise<ClientFaces> {
  // Variable specifiers keep Host and Client Cordis declaration merging separate.
  const specifiers = [
    '@deepseek-ai/dsh-typert-registry/client',
    '@deepseek-ai/dsh-client-connection/client',
    '@deepseek-ai/dsh-api-gateway/client',
  ]
  return clientFaces ??= Promise.all(specifiers.map(specifier => import(specifier)))
    .then(([typert, connection, gateway]) => ({ typert, connection, gateway }))
}

const agentScopeKey = Symbol('deeppilot.dsh-client.agent-scope')

type AgentContext = Context & { [agentScopeKey]?: string }

function scopeOf(ctx: Context): string | undefined {
  return (ctx as AgentContext)[agentScopeKey]
}

function createAgentScope(ctx: Context, identity: string): Context {
  const fiber = ctx.plugin(function deeppilotAgentScope() {})
  return fiber.ctx.extend({
    [agentScopeKey]: identity,
    [Context.filter](listenerCtx: Context) {
      const listenerIdentity = scopeOf(listenerCtx)
      return listenerIdentity === undefined || listenerIdentity === identity
    },
  })
}

function inProcessStream(
  gateway: HostGatewayLike,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  peer: HostPeerLike,
): AsyncIterable<unknown> {
  return (async function* () {
    const source = await gateway.wireStream.open(endpoint, payload, undefined, peer, signal)
    yield* source
  })()
}

/**
 * Start one headless official DSH Client backed by the Host's in-process
 * Connection and Gateway carriers.
 *
 * The returned disposer tears down the Remote Events generation, all pending
 * listeners, and every lazily minted Agent scope.
 */
export async function startDshRemoteInteractions(
  hostCtx: Context,
  handlers: DshRemoteInteractionHandlers,
): Promise<() => Promise<void>> {
  const connection = hostCtx.get('connection') as HostConnectionLike | undefined
  const gateway = hostCtx.get('typertGateway') as HostGatewayLike | undefined
  if (connection === undefined) throw new Error('DSH Host connection is unavailable')
  if (gateway === undefined) throw new Error('DSH typertGateway is unavailable')

  const faces = await loadClientFaces()

  const client = new Context()
  const peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })
  const fetchHandler = connection.createSharedFetchHandler('/api')
  const transport: ClientTransportHooksLike = {
    fetch: (input, init) => fetchHandler.fetch(inProcessRemoteRequest(input, init), peer),
    openStream: (endpoint, payload, signal) => inProcessStream(gateway, endpoint, payload, signal, peer),
    ownsHost: true,
  }

  try {
    faces.typert.apply(client)

    faces.connection.installConnection(client, { transport, interactions: 'answer' })

    const typert = client.get('typert') as ClientTypertLike | undefined
    if (typert === undefined) throw new Error('resident DSH Client typert service was not installed')
    const scopes = new Map<string, Context>()
    typert.contexts.registerClient('agent', {
      identity: candidate => scopeOf(candidate),
      resolve: identity => {
        let scope = scopes.get(identity)
        if (scope === undefined) {
          scope = createAgentScope(client, identity)
          scopes.set(identity, scope)
        }
        return scope
      },
    })

    // The Gateway opens its Remote Events generation asynchronously. Register
    // both listeners immediately after apply so a replayed pending request is
    // claimed before the first stream item can be dispatched.
    faces.gateway.apply(client)
    const remote = client.get('remote') as ClientRemoteLike | undefined
    if (remote === undefined) throw new Error('resident DSH Client remote service was not installed')
    remote.$on('approval/request', function (request, next) {
      return handlers.approval(scopeOf(this) ?? '', request as RemoteApprovalRequest, next)
    })
    remote.$on('user-questions/request', function (request, next) {
      return handlers.question(scopeOf(this) ?? '', request as RemoteQuestionRequest, next)
    })

    return async () => {
      await client.fiber.dispose()
    }
  } catch (error) {
    await client.fiber.dispose()
    throw error
  }
}
