import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { PROTOCOL_VERSION, type PluginUpdatePhase, type PluginUpdateProgressPayload, type PluginUpdateStatusPayload } from './protocol.ts'

/** Structural subset checked against dsh-plugin-manager's real published declarations.
 * Keep this optional: older supported hosts do not ship updateBundle. */
export interface UpdateChangeResult {
  changed: boolean
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  stage: 'install' | 'enable' | 'remove'
  target: string
  version?: string
  restartReason?: string
  error?: { code: string; incompatible?: unknown[] }
  packageResult?: { incompatible?: unknown[]; kind?: 'pnpm-missing' | 'timeout' | 'not-found' | 'no-matching-version' | 'network' | 'disk-full' | 'permission' | 'build-blocked' | 'integrity' | 'unknown' }
  pendingBuilds?: string[]
}
export interface PluginUpdateRegistries {
  registry: string | null
  fallbackRegistries: readonly string[]
  resolved: string | null
}

export interface PluginManagerForUpdate {
  listVersions(name: string): Promise<
    | { status: 'listed'; installed: string; registry: string | null; versions: readonly { version: string; bundle: boolean; incompatible?: { name: string; version: string; runtimeVersion: string; requirements: Record<string, string> } }[] }
    | { status: 'refused'; problem: string; reason: string }>
  registries(): Promise<PluginUpdateRegistries>
  listBundles(): Promise<readonly { name: string; version?: string }[]>
  updateBundle(name: string, version: string, options?: { registry?: string | null; requestId?: string }): Promise<{
    from: string; to: string; step: 'check' | 'remove' | 'install'; result: UpdateChangeResult; restore?: UpdateChangeResult
  }>
}

const PACKAGE = 'dsh-deeppilot'
const PHASES: readonly PluginUpdatePhase[] = ['preparing', 'installing', 'verifying', 'restart-required', 'done', 'rolled-back', 'failed']
export interface UpdateJournalRecord {
  clientRequestId: string
  fromVersion: string
  toVersion: string
  phase: PluginUpdatePhase
  startedAt: number
  message: string
}
interface StoredRecord extends UpdateJournalRecord {
  ownerKey: string
  restartVersion?: string
  restartPhase?: 'done' | 'rolled-back'
  restartBoot?: string
}
interface SharedState {
  bootId: string
  records: StoredRecord[]
  listeners: Set<(event: PluginUpdateProgressPayload, owner: string) => void>
  runningVersion: string
  active?: Promise<void>
  pending?: { record: StoredRecord; accepted: Promise<UpdateJournalRecord> }
  healthy: boolean
}
// A plugin HMR unload must not own or cancel the package-manager operation. The
// process-wide cell also stops the newly loaded copy mistaking an active update
// for an interrupted one. Only durable, credential-free facts cross restarts.
const CELLS = Symbol.for('deeppilot.plugin-update.cells.v1')
const globals = globalThis as typeof globalThis & { [CELLS]?: Map<string, SharedState> }
const cells = globals[CELLS] ??= new Map<string, SharedState>()
const ownerKey = (deviceId: string) => createHash('sha256').update(deviceId).digest('hex')
const validVersion = (value: unknown): value is string => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value) && value.length <= 128
export const validUpdateRequestId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
const terminal = (phase: PluginUpdatePhase) => ['done', 'failed', 'rolled-back', 'restart-required'].includes(phase)
const publicRecord = ({ ownerKey: _owner, restartVersion: _restartVersion, restartPhase: _restartPhase, restartBoot: _restartBoot, ...record }: StoredRecord): UpdateJournalRecord => ({ ...record })

export class PluginUpdateError extends Error {
  constructor(readonly code: 'E_PROTOCOL' | 'E_FORBIDDEN' | 'E_UNSUPPORTED' | 'E_BUSY' | 'E_INTERNAL', message: string) { super(message) }
}

export interface PluginUpdaterOptions {
  manager: PluginManagerForUpdate
  currentVersion: string
  journalPath: string
  /** Tests supply an isolated registry response; production never reads npm credentials. */
  fetch?: typeof fetch
}

/** 精确镜像 alpha2 公开 registryPlan，避免静态依赖让旧宿主无法加载插件；由真实函数对照测试守卫。 */
export function updateRegistryPlan(requested: string | null | undefined, configured: PluginUpdateRegistries): Array<string | null> {
  const own = configured.resolved === null ? null : normalizeUpdateRegistry(configured.resolved)
  const fallbacks = configured.fallbackRegistries.map(normalizeUpdateRegistry)
  const ownIsPublic = own !== null && (own === 'https://registry.npmjs.org/' || fallbacks.includes(own))
  const keyOf = (registry: string | null) => registry === null ? own : normalizeUpdateRegistry(registry)
  const known: Array<string | null> = []
  const keys: Array<string | null> = []
  for (const registry of [configured.registry, ...configured.fallbackRegistries]) {
    if (registry === null && !ownIsPublic) continue
    const key = keyOf(registry)
    if (keys.includes(key)) continue
    known.push(registry === null ? null : normalizeUpdateRegistry(registry))
    keys.push(key)
  }
  const first = requested === undefined ? configured.registry : requested
  const firstKey = keyOf(first)
  const normalizedFirst = first === null ? null : normalizeUpdateRegistry(first)
  if ((first === null || firstKey === own) && !ownIsPublic) return [normalizedFirst]
  if (!keys.includes(firstKey)) return [normalizedFirst]
  return [normalizedFirst, ...known.filter((_registry, index) => keys[index] !== firstKey)]
}

function normalizeUpdateRegistry(registry: string): string {
  const parsed = new URL(registry)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('registry unavailable')
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
  return parsed.href
}

function updateRegistrySources(requested: string | null, configured: PluginUpdateRegistries): string[] {
  return [...new Set(updateRegistryPlan(requested, configured).map(registry => {
    const resolved = registry === null ? configured.resolved : registry
    if (!resolved) throw new Error('registry unresolved')
    return normalizeUpdateRegistry(resolved)
  }))]
}

/** 只接受具有完整规范摘要的强 SRI；宽松 base64 解码不能把截断值或弱摘要当作安装凭据。 */
function strongIntegrity(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match) return undefined
  const digest = Buffer.from(match[2]!, 'base64')
  const bytes = { sha256: 32, sha384: 48, sha512: 64 }[match[1] as 'sha256' | 'sha384' | 'sha512']
  return digest.length === bytes && digest.toString('base64') === match[2] ? value : undefined
}

/** 精确版本事实由元数据读取；软件源地址、上游响应体及包管理器诊断不进入对外错误。 */
async function readTargetManifestFacts(registry: string, version: string, fetcher: typeof fetch): Promise<{ protocolVersion?: number; integrity?: string }> {
  const base = new URL(registry)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !validVersion(version)) throw new Error('registry unavailable')
  base.pathname = base.pathname.replace(/\/?$/, '/') + encodeURIComponent(PACKAGE) + '/' + encodeURIComponent(version)
  const response = await fetcher(base, { signal: AbortSignal.timeout(10_000), redirect: 'error', headers: { accept: 'application/json' } })
  if (!response.ok || !response.body) throw new Error('manifest unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.length
      if (bytes > 1024 * 1024) throw new Error('manifest too large')
      chunks.push(next.value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { name?: unknown; version?: unknown; deepPilot?: { protocolVersion?: unknown }; dsh?: { bundle?: unknown }; dist?: { integrity?: unknown } }
  if (manifest.name !== PACKAGE || manifest.version !== version || !manifest.dsh?.bundle) throw new Error('manifest mismatch')
  const protocol = manifest.deepPilot?.protocolVersion
  return { protocolVersion: typeof protocol === 'number' && Number.isSafeInteger(protocol) && protocol > 0 ? protocol : undefined,
    integrity: strongIntegrity(manifest.dist?.integrity) }
}

/** 检查界面只预览首个软件源的协议；实际安装必须通过全部可回退源的强校验。 */
export async function readTargetProtocol(registry: string, version: string, fetcher: typeof fetch = fetch): Promise<number | undefined> {
  return (await readTargetManifestFacts(registry, version, fetcher)).protocolVersion
}

export class PluginUpdater {
  private readonly state: SharedState
  private readonly path: string
  private readonly listVersions: PluginManagerForUpdate['listVersions']
  private readonly updateBundle: PluginManagerForUpdate['updateBundle']
  private readonly listBundles: PluginManagerForUpdate['listBundles']
  private readonly registries: PluginManagerForUpdate['registries']

  constructor(private readonly options: PluginUpdaterOptions) {
    this.path = resolve(options.journalPath)
    // Capture the host service while this context is live. No continuation uses
    // the disposed plugin context or the phone socket's abort signal.
    this.listVersions = options.manager.listVersions.bind(options.manager)
    this.updateBundle = options.manager.updateBundle.bind(options.manager)
    this.listBundles = options.manager.listBundles.bind(options.manager)
    this.registries = options.manager.registries.bind(options.manager)
    let state = cells.get(this.path)
    if (!state) {
      state = { bootId: randomUUID(), records: [], listeners: new Set(), runningVersion: options.currentVersion, healthy: true }
      if (existsSync(this.path)) {
        try {
          if (statSync(this.path).size > 256 * 1024) throw new Error('oversized journal')
          const data = JSON.parse(readFileSync(this.path, 'utf8')) as { version?: unknown; records?: StoredRecord[] }
          if (data.version !== 1 || !Array.isArray(data.records) || data.records.length > 128 || data.records.some(record =>
            !record || !validUpdateRequestId(record.clientRequestId) || !validVersion(record.fromVersion) || !validVersion(record.toVersion) ||
            !PHASES.includes(record.phase) || !Number.isSafeInteger(record.startedAt) || record.startedAt < 0 ||
            typeof record.message !== 'string' || record.message.length > 1024 || !/^[a-f0-9]{64}$/.test(record.ownerKey) ||
            (record.restartVersion !== undefined && !validVersion(record.restartVersion)) ||
            (record.restartBoot !== undefined && (typeof record.restartBoot !== 'string' || record.restartBoot.length > 128)) ||
            (record.restartPhase !== undefined && record.restartPhase !== 'done' && record.restartPhase !== 'rolled-back')) ||
            new Set(data.records.map(record => record.clientRequestId)).size !== data.records.length) throw new Error('invalid journal')
          state.records = data.records
        } catch { state.healthy = false }
      }
      cells.set(this.path, state)
    }
    this.state = state
    state.runningVersion = options.currentVersion
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = this.path + '.' + randomUUID() + '.tmp'
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify({ version: 1, records: this.state.records })); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, this.path)
    const directory = openSync(dirname(this.path), 'r')
    try { fsyncSync(directory) } catch (error) {
      // These platforms cannot fsync directories. File fsync and same-directory
      // rename already succeeded; all actual I/O failures still refuse progress.
      if (!['EPERM', 'EISDIR', 'EINVAL'].includes(String((error as NodeJS.ErrnoException).code))) throw error
    } finally { closeSync(directory) }
  }

  private transition(record: StoredRecord, phase: PluginUpdatePhase, message: string): void {
    const before = { ...record }
    record.phase = phase
    record.message = message
    if (phase === 'restart-required') record.restartBoot = this.state.bootId
    // Never publish a terminal result that cannot survive the reconnect.
    try { this.save() } catch (error) { Object.assign(record, before); record.restartBoot = before.restartBoot; throw error }
    for (const listener of this.state.listeners) {
      try { listener({ clientRequestId: record.clientRequestId, phase, message }, record.ownerKey) } catch { /* disconnected sink */ }
    }
  }

  subscribe(deviceId: string, listener: (event: PluginUpdateProgressPayload) => void): () => void {
    const key = ownerKey(deviceId)
    const wrapped = (event: PluginUpdateProgressPayload, owner: string) => { if (owner === key) listener(event) }
    this.state.listeners.add(wrapped)
    return () => { this.state.listeners.delete(wrapped) }
  }

  private recover(): void {
    if (this.state.active || !this.state.healthy) return
    for (const record of this.state.records) {
      if (record.phase === 'restart-required' && record.restartBoot !== this.state.bootId && this.options.currentVersion === (record.restartVersion ?? record.toVersion)) {
        this.transition(record, record.restartPhase ?? 'done', record.restartPhase === 'rolled-back' ? '重启后已运行旧版本，宿主回滚完成' : '重启后已运行目标版本，更新完成')
      } else if (!terminal(record.phase)) {
        if (this.options.currentVersion === record.toVersion) this.transition(record, 'done', '已重新连接到目标版本，更新完成')
        else this.transition(record, 'failed', '上次更新已中断，结果无法确认；请检查当前版本，原请求不会自动重试')
      }
    }
  }

  async check(deviceId: string): Promise<PluginUpdateStatusPayload> {
    let reason: string | undefined
    try { this.recover() } catch { reason = '更新日志保存失败，暂时无法确认更新结果' }
    if (!this.state.healthy) reason = '更新日志无法读取，已停用安装以保护上次更新记录'
    const finish = (status: PluginUpdateStatusPayload): PluginUpdateStatusPayload => {
      // The host operation can settle while registry reads are in flight. Take
      // the journal snapshot when replying, so a fresh terminal never regresses
      // to the preparing/installing snapshot captured at check's start.
      const journal = [...this.state.records].reverse().find(record => record.ownerKey === ownerKey(deviceId))
      return { ...status, ...(journal ? { journal: publicRecord(journal) } : {}) }
    }
    const base = {
      currentVersion: this.options.currentVersion, protocolVersion: PROTOCOL_VERSION,
      latestVersion: null, updateAvailable: false, compatible: false, protocolCompatible: false,
      versions: [], checkedAt: Date.now(),
    }
    try {
      const listed = await this.listVersions(PACKAGE)
      if (listed.status !== 'listed') return finish({ ...base, reason: reason ?? '暂时无法读取可更新版本，请稍后重试' })
      const registry = listed.registry ?? (await this.registries()).resolved
      if (!registry) return finish({ ...base, reason: reason ?? '无法确定软件源，暂时不能核对目标版本协议' })
      const versions = await Promise.all(listed.versions.slice(0, 10).map(async entry => {
        let protocolVersion: number | undefined
        try { protocolVersion = await readTargetProtocol(registry, entry.version, this.options.fetch) } catch { /* unavailable target stays unselectable */ }
        return { version: entry.version, compatible: entry.bundle && entry.incompatible === undefined, ...(protocolVersion === undefined ? {} : { protocolVersion }) }
      }))
      const latest = versions[0]
      return finish({ ...base, latestVersion: latest?.version ?? null, updateAvailable: versions.length > 0,
        compatible: latest?.compatible ?? false, protocolCompatible: latest?.protocolVersion === PROTOCOL_VERSION, versions,
        ...(reason ? { reason } : versions.some(entry => entry.protocolVersion === undefined) ? { reason: '部分目标版本缺少可核验的协议声明，暂时不可安装' } : {}) })
    } catch { return finish({ ...base, reason: reason ?? '暂时无法检查更新，请确认网络后重试' }) }
  }

  /** The apply frame is the phone's explicit confirmation. check() never mutates packages. */
  async apply(deviceId: string, version: string, clientRequestId: string): Promise<UpdateJournalRecord> {
    if (!validVersion(version) || !validUpdateRequestId(clientRequestId)) throw new PluginUpdateError('E_PROTOCOL', '更新版本或请求标识无效')
    if (!this.state.healthy) throw new PluginUpdateError('E_INTERNAL', '更新日志无法读取，暂时不能安装')
    const previous = this.state.records.find(record => record.clientRequestId === clientRequestId)
    if (previous) {
      if (previous.ownerKey !== ownerKey(deviceId)) throw new PluginUpdateError('E_FORBIDDEN', '更新请求不属于当前设备')
      if (previous.toVersion !== version) throw new PluginUpdateError('E_PROTOCOL', '同一更新请求不能更换目标版本')
      this.recover()
      return publicRecord(previous)
    }
    const pending = this.state.pending
    if (pending?.record.clientRequestId === clientRequestId) {
      if (pending.record.ownerKey !== ownerKey(deviceId)) throw new PluginUpdateError('E_FORBIDDEN', '更新请求不属于当前设备')
      if (pending.record.toVersion !== version) throw new PluginUpdateError('E_PROTOCOL', '同一更新请求不能更换目标版本')
      return pending.accepted
    }
    if (this.state.active) throw new PluginUpdateError('E_BUSY', '已有插件更新正在进行，请稍后检查结果')
    if (this.state.records.length >= 128) throw new PluginUpdateError('E_INTERNAL', '更新记录已满，请在电脑端检查后再更新')
    const record: StoredRecord = { clientRequestId, fromVersion: this.options.currentVersion, toVersion: version,
      phase: 'preparing', startedAt: Date.now(), message: '目标校验已通过，准备开始安装', ownerKey: ownerKey(deviceId) }
    let accept!: (record: UpdateJournalRecord) => void
    let refuse!: (error: unknown) => void
    const accepted = new Promise<UpdateJournalRecord>((resolve_, reject_) => { accept = resolve_; refuse = reject_ })
    this.state.pending = { record, accepted }
    // 预检第一次等待前就保留活动槽；同编号共享受理结果，其他请求不能越过预检并发安装。
    const operation = Promise.resolve().then(async () => {
      let registry: string | null
      try {
        registry = await this.prepare(record)
        this.state.records.push(record)
        try { this.save() } catch {
          this.state.records.splice(this.state.records.indexOf(record), 1)
          throw new PluginUpdateError('E_INTERNAL', '更新日志保存失败，尚未开始安装')
        }
      } catch (error) {
        if (this.state.active === operation) this.state.active = undefined
        if (this.state.pending?.record === record) this.state.pending = undefined
        refuse(error instanceof PluginUpdateError ? error : new PluginUpdateError('E_INTERNAL', '无法核对目标版本，尚未开始安装'))
        return
      }
      if (this.state.pending?.record === record) this.state.pending = undefined
      accept(publicRecord(record))
      // 先让 wire 发送受理回执，再进入可能卸载本插件的宿主操作；不借用 socket 的生命周期。
      await new Promise<void>(resolve_ => setImmediate(resolve_))
      try { await this.run(record, registry) } catch {
        try { this.transition(record, 'failed', '更新结果无法确认，请检查当前版本；原请求不会自动重试') } catch { /* 保留最后一个耐久中间态供重连核对。 */ }
      }
    }).finally(() => { if (this.state.active === operation) this.state.active = undefined })
    this.state.active = operation
    return accepted
  }

  /** Useful to isolated tests; production never waits for this from disposal. */
  async settled(): Promise<void> { await this.state.active }

  /** 所有可执行目标校验在受理前完成；宿主安装及其回滚处理仍属于独立的后续任务。 */
  private async prepare(record: StoredRecord): Promise<string | null> {
    let listed: Awaited<ReturnType<PluginManagerForUpdate['listVersions']>>
    try { listed = await this.listVersions(PACKAGE) } catch { throw new PluginUpdateError('E_INTERNAL', '无法核对可更新版本，尚未开始安装') }
    if (listed.status !== 'listed' || listed.installed !== record.fromVersion) throw new PluginUpdateError('E_PROTOCOL', '安装版本已变化或无法读取，请重新检查更新')
    const target = listed.versions.find(entry => entry.version === record.toVersion)
    if (!target?.bundle || target.incompatible !== undefined) throw new PluginUpdateError('E_UNSUPPORTED', '目标版本不存在或不兼容当前宿主，尚未开始安装')
    try {
      const sources = updateRegistrySources(listed.registry, await this.registries())
      let integrity: string | undefined
      for (const source of sources) {
        const facts = await readTargetManifestFacts(source, record.toVersion, this.options.fetch ?? fetch)
        if (facts.protocolVersion !== PROTOCOL_VERSION) throw new PluginUpdateError('E_UNSUPPORTED', '候选软件源的目标协议不兼容或缺少声明，尚未开始安装')
        if (!facts.integrity) throw new PluginUpdateError('E_UNSUPPORTED', '候选软件源缺少有效的强完整性摘要，尚未开始安装')
        if (integrity !== undefined && facts.integrity !== integrity) throw new PluginUpdateError('E_UNSUPPORTED', '候选软件源的目标包完整性摘要不一致，尚未开始安装')
        integrity = facts.integrity
      }
      // 宿主的查询和安装阶段会重新计算计划；预检中配置变动时不能继续使用旧候选集合。
      const current = updateRegistrySources(listed.registry, await this.registries())
      if (JSON.stringify(current) !== JSON.stringify(sources)) throw new PluginUpdateError('E_BUSY', '软件源配置已变化，请重新检查更新')
    } catch (error) {
      if (error instanceof PluginUpdateError) throw error
      throw new PluginUpdateError('E_INTERNAL', '无法核验全部候选软件源的目标协议与完整性，尚未开始安装')
    }
    return listed.registry
  }

  private async run(record: StoredRecord, registry: string | null): Promise<void> {
    this.transition(record, 'installing', '宿主正在安装目标版本，连接可能暂时中断')
    const outcome = await this.updateBundle(PACKAGE, record.toVersion, { registry, requestId: record.clientRequestId })
    const result = outcome.result
    if (outcome.from !== record.fromVersion || outcome.to !== record.toVersion) return this.transition(record, 'failed', '宿主返回的更新版本不一致，请检查当前安装')
    if (outcome.restore) {
      const restored = outcome.restore
      if (restored.application === 'restart-required') {
        record.restartVersion = record.fromVersion
        record.restartPhase = 'rolled-back'
        return this.transition(record, 'restart-required', '目标安装失败，旧版已重新安装；请在电脑端重启 DSH 后确认恢复')
      }
      if (restored.application === 'applied' && (restored.version === undefined || restored.version === record.fromVersion)) {
        const installed = (await this.listBundles()).find(bundle => bundle.name === PACKAGE)
        if (installed?.version === record.fromVersion) return this.transition(record, 'rolled-back', '目标安装失败，宿主已自动恢复旧版本')
        return this.transition(record, 'failed', '宿主已尝试回滚，但无法核对实际旧版本，请在电脑端检查插件')
      }
      return this.transition(record, 'failed', '目标安装失败，宿主恢复旧版也未完成，请在电脑端检查插件')
    }
    if (outcome.step !== 'install' || result.application === 'failed' || result.application === 'cancelled' || result.application === 'overridden') {
      return this.transition(record, 'failed', installFailureMessage(result))
    }
    if (result.version !== undefined && result.version !== record.toVersion) return this.transition(record, 'failed', '实际安装版本与目标不一致，请在电脑端检查')
    if (result.application === 'restart-required') return this.transition(record, 'restart-required', '目标版本已安装，宿主需要重启；请在电脑端重启 DSH 后重新连接')
    this.transition(record, 'verifying', '正在核对实际安装版本')
    const installed = (await this.listBundles()).find(bundle => bundle.name === PACKAGE)
    if (installed?.version !== record.toVersion) return this.transition(record, 'failed', '无法确认实际安装版本，请在电脑端检查')
    if (this.state.runningVersion !== record.toVersion) return this.transition(record, 'restart-required', '目标版本已安装，当前插件尚未重新加载；请在电脑端重启 DSH 后重新连接')
    this.transition(record, 'done', '目标版本已加载，更新完成')
  }
}

function installFailureMessage(result: UpdateChangeResult): string {
  if (result.error?.code === 'incompatible-version' || result.error?.incompatible?.length || result.packageResult?.incompatible?.length) return '目标版本不兼容当前宿主，安装已拒绝（incompatible-version）'
  if (result.pendingBuilds?.length || result.packageResult?.kind === 'build-blocked') return '安装需要在电脑端明确批准构建脚本，更新未完成（build-blocked）'
  const kind = result.packageResult?.kind
  const reasons: Partial<Record<NonNullable<typeof kind>, string>> = {
    'pnpm-missing': '电脑端缺少包管理器，更新未完成', timeout: '安装等待超时，请检查电脑端后重试',
    'not-found': '软件源尚未提供目标包，更新未完成', 'no-matching-version': '软件源尚未提供目标版本，更新未完成',
    network: '安装无法连接软件源，请恢复网络后重新检查', 'disk-full': '电脑端磁盘空间不足，更新未完成',
    permission: '电脑端没有写入插件的权限，更新未完成', integrity: '目标包完整性校验失败，更新未完成',
  }
  if (kind && reasons[kind]) return `${reasons[kind]}（${kind}）`
  if (result.application === 'cancelled') return '宿主已取消目标版本安装，请检查当前版本'
  return '宿主未完成目标版本安装，请检查当前版本'
}

export function supportsPluginUpdate(value: unknown): value is PluginManagerForUpdate {
  if (!value || typeof value !== 'object') return false
  return ['listVersions', 'updateBundle', 'listBundles', 'registries'].every(key => typeof (value as Record<string, unknown>)[key] === 'function')
}
