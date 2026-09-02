/**
 * Resident DSH 0.1.2-alpha.3 Remote Events client for phone interactions.
 *
 * The Host-side `approval/request` and `user-questions/request` events are
 * owned once by DSH API Remotes. API Gateway then fans each pending waterfall
 * out to every connected Client and settles the first result. DeepPilot joins
 * that official Client plane in-process instead of registering a competing
 * Host waterfall listener or replacing the official Web composer.
 */
import { Context } from '@deepseek-ai/cordis'
import * as Cordis from '@deepseek-ai/cordis'

interface FetchHandlerLike {
  fetch(request: Request): Promise<Response>
}

interface HostConnectionLike {
  createSharedFetchHandler(channel: '/api'): FetchHandlerLike
}

interface HostGatewayLike {
  wireStream: {
    open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>>
  }
}

interface ClientTransportHooksLike {
  fetch(input: URL, init: RequestInit): Promise<Response>
  openStream(endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown>
  ownsHost: true
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

export interface Dsh012RemoteInteractionHandlers {
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
      ]) await import(specifier)
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

function inProcessStream(
  gateway: HostGatewayLike,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
): AsyncIterable<unknown> {
  return (async function* () {
    const source = await gateway.wireStream.open(endpoint, payload, signal)
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
export async function startDsh012RemoteInteractions(
  hostCtx: Context,
  handlers: Dsh012RemoteInteractionHandlers,
): Promise<() => Promise<void>> {
  const connection = hostCtx.get('connection') as HostConnectionLike | undefined
  const gateway = hostCtx.get('typertGateway') as HostGatewayLike | undefined
  if (connection === undefined) throw new Error('dsh 0.1.2-alpha.3 Host connection is unavailable')
  if (gateway === undefined) throw new Error('dsh 0.1.2-alpha.3 typertGateway is unavailable')

  const faces = await loadClientFaces()

  const client = new Context()
  const fetchHandler = connection.createSharedFetchHandler('/api')
  const transport: ClientTransportHooksLike = {
    fetch: (input, init) => fetchHandler.fetch(new Request(input, init)),
    openStream: (endpoint, payload, signal) => inProcessStream(gateway, endpoint, payload, signal),
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
      faces.connection.apply(client)
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
