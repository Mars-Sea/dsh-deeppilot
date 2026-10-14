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
import * as Cordis from '@deepseek-ai/cordis'

/**
 * One Peer admitted to the Host. DSH names it on every in-process carrier call
 * from 0.2.1-alpha.3 on; the Host's own operator Peer stands in before that.
 */
export interface HostPeerLike {
  readonly principal: { readonly kind: string }
  readonly signal: AbortSignal
  readonly interactions: 'answer' | 'none'
}

interface FetchHandlerLike {
  /** `peer` is required from alpha.3 on and ignored by earlier hosts. */
  fetch(request: Request, peer: HostPeerLike | undefined): Promise<Response>
}

interface HostConnectionLike {
  createSharedFetchHandler(channel: '/api'): FetchHandlerLike
  /**
   * alpha.3's only entry point that can name both the principal and the
   * forwarded-event participation. Absent before it, where the service instead
   * holds the operator Peer every call speaks for.
   */
  createPeer?(options: { principal: { kind: 'owner' }; interactions: 'answer' | 'none' }): HostPeerLike
  operator?: HostPeerLike
}

interface HostWireStreamLike {
  open(
    endpoint: string,
    payload: unknown,
    uplink: undefined,
    peer: HostPeerLike | undefined,
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

/** Carrier inputs the explicit Connection installer accepts on both audited hosts. */
interface ClientConnectionInstallOptionsLike {
  transport: ClientTransportHooksLike
  interactions: 'answer' | 'none'
}

interface ClientPluginModule {
  apply(ctx: Context): void
  /**
   * Explicit installer, present on both audited hosts. Without it the carrier
   * can only arrive through the process global `apply()` reads, and the
   * forwarded-event participation cannot be named at all.
   */
  installConnection?(ctx: Context, options: ClientConnectionInstallOptionsLike): void
}

/**
 * Install the Connection service on the resident Client.
 *
 * alpha.3 selects `interactions: 'none'` for any caller that supplies no page
 * location, and that mode forbids the forwarded-event stream this resident
 * client exists to answer. Only the explicit installer can name the
 * participation, so it takes precedence; `apply` stays for a host older than
 * the installer, reading the carrier from the process global set around it.
 */
export function installResidentConnection(
  connection: ClientPluginModule,
  ctx: Context,
  transport: ClientTransportHooksLike,
): void {
  if (typeof connection.installConnection === 'function') {
    connection.installConnection(ctx, { transport, interactions: 'answer' })
    return
  }
  connection.apply(ctx)
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

type TransportGlobal = typeof globalThis & {
  __DSH_TRANSPORT__?: ClientTransportHooksLike
}

interface ClientBundleDefinition {
  id: string
  factory(require: (id: string) => unknown): unknown
}

type ClientBundleWindow = {
  __ModuleLoader__: {
    load(definition: ClientBundleDefinition): void
  }
}

type LoaderGlobal = {
  window?: ClientBundleWindow
}

interface ClientFaces {
  typert: ClientPluginModule
  connection: ClientPluginModule
  gateway: ClientPluginModule
}

let clientFaces: Promise<ClientFaces> | undefined

/**
 * Load DSH's browser-distributed Client faces into a tiny Host-side module
 * table. Published `lib/client.js` files register with `window.__ModuleLoader__`
 * rather than exporting ESM values, so a normal Node import cannot consume
 * them. The shim runs only while the three official bundles register; their
 * apply functions then operate against a non-browser Cordis Context.
 */
function pluginModule(value: unknown, specifier: string): ClientPluginModule {
  if (typeof value !== 'object' || value === null) throw new Error(`${specifier} Client bundle returned no exports`)
  const record = value as Record<string, unknown>
  if (typeof record.apply !== 'function') throw new Error(`${specifier} has no Client apply() export`)
  return value as unknown as ClientPluginModule
}

/**
 * Register one loaded Client face when the browser banner did not.
 *
 * alpha.3 resolves these specifiers through the `node` export condition to a
 * bundle that exports the face as ordinary ESM and never calls
 * `window.__ModuleLoader__.load`, while earlier hosts only ship the banner
 * shape. A banner registration wins, because it is what the bundle's own
 * internal `require()` calls resolve against; the ESM namespace is the fallback.
 */
export function adoptClientModule(
  modules: Map<string, unknown>,
  specifier: string,
  loaded: unknown,
): void {
  const id = specifier.replace(/\/client$/, '')
  if (!modules.has(id)) modules.set(id, loaded)
}

async function loadClientFaces(): Promise<ClientFaces> {
  clientFaces ??= (async () => {
    const modules = new Map<string, unknown>([['@deepseek-ai/cordis', Cordis]])
    const loaderGlobal = globalThis as unknown as LoaderGlobal
    const previousWindow = loaderGlobal.window
    loaderGlobal.window = {
      __ModuleLoader__: {
        load: definition => {
          const exports = definition.factory((id) => {
            if (!modules.has(id)) throw new Error(`resident DSH Client cannot resolve ${JSON.stringify(id)}`)
            return modules.get(id)
          })
          modules.set(definition.id, exports)
        },
      },
    }
    try {
      // Use variable specifiers to preserve DSH's Host/Client TypeScript face
      // split; static imports would merge incompatible Context declarations.
      for (const specifier of [
        '@deepseek-ai/dsh-typert-registry/client',
        '@deepseek-ai/dsh-client-connection/client',
        '@deepseek-ai/dsh-api-gateway/client',
      ]) {
        adoptClientModule(modules, specifier, await import(specifier))
      }
    } finally {
      if (previousWindow === undefined) delete loaderGlobal.window
      else loaderGlobal.window = previousWindow
    }
    return {
      typert: pluginModule(modules.get('@deepseek-ai/dsh-typert-registry'), '@deepseek-ai/dsh-typert-registry/client'),
      connection: pluginModule(modules.get('@deepseek-ai/dsh-client-connection'), '@deepseek-ai/dsh-client-connection/client'),
      gateway: pluginModule(modules.get('@deepseek-ai/dsh-api-gateway'), '@deepseek-ai/dsh-api-gateway/client'),
    }
  })()
  return clientFaces
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

/**
 * Mint the Peer every in-process carrier call speaks for.
 *
 * alpha.3 requires a Peer on `fetch` and on `wireStream.open`, and refuses a
 * forwarded-event stream unless that Peer declares `interactions: 'answer'`.
 * Its connection service therefore grows `createPeer`, the only entry point
 * that can name the principal and the participation together. Before that the
 * service holds one operator Peer and defaults every absent Peer to it, so that
 * instance is the drop-in answer. A host with neither yields undefined, which
 * only the pre-alpha.3 carrier accepts.
 */
function createHostPeer(connection: HostConnectionLike): HostPeerLike | undefined {
  if (typeof connection.createPeer === 'function') {
    return connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })
  }
  return connection.operator
}

function inProcessStream(
  gateway: HostGatewayLike,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  peer: HostPeerLike | undefined,
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
  const peer = createHostPeer(connection)
  const fetchHandler = connection.createSharedFetchHandler('/api')
  const transport: ClientTransportHooksLike = {
    fetch: (input, init) => fetchHandler.fetch(inProcessRemoteRequest(input, init), peer),
    openStream: (endpoint, payload, signal) => inProcessStream(gateway, endpoint, payload, signal, peer),
    ownsHost: true,
  }

  try {
    faces.typert.apply(client)

    // Client Connection reads this hook once during apply() and retains the
    // concrete functions. Restore the process global immediately afterward so
    // no unrelated Client composition inherits DeepPilot's carrier.
    const transportGlobal = globalThis as TransportGlobal
    const previousTransport = transportGlobal.__DSH_TRANSPORT__
    transportGlobal.__DSH_TRANSPORT__ = transport
    try {
      installResidentConnection(faces.connection, client, transport)
    } finally {
      if (previousTransport === undefined) delete transportGlobal.__DSH_TRANSPORT__
      else transportGlobal.__DSH_TRANSPORT__ = previousTransport
    }

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
