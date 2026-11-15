#!/usr/bin/env node
/** Real DSH rc.3 updateBundle regression. No publication and no personal profile.
 * Run only after the caller's build finishes:
 * node scripts/smoke-directory-hmr.mjs --run --artifacts-ready [--scratch /absolute/new-directory]
 * A scratch directory retains packages, redacted logs and evidence.json. Synthetic
 * device private keys stay in worker memory. All listeners are forced to loopback
 * port 0 in workers because DeepPilot's production LAN transport binds wildcard.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire, registerHooks } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, cp, realpath, readdir } from 'node:fs/promises'
import { existsSync, createReadStream, appendFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { dirname, join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { format } from 'node:util'

const SCRIPT = fileURLToPath(import.meta.url)
const REPO = resolve(dirname(SCRIPT), '..')
const fixedRootFlag = process.argv.indexOf('--fixed-root')
const FIXED_ROOT = resolve(fixedRootFlag === -1 ? (process.env.HMR_FIXED_ROOT ?? REPO) : process.argv[fixedRootFlag + 1])
const installFlag = process.argv.indexOf('--dsh-install')
const installCandidates = [
  installFlag === -1 ? undefined : process.argv[installFlag + 1],
  process.env.HMR_DSH_INSTALL,
  process.env.DSH_INSTALL_DIR,
  resolve(dirname(process.execPath), '../lib/node_modules/@deepseek-ai/dsh'),
].filter(Boolean)
const INSTALL = resolve(installCandidates.find(candidate => existsSync(join(candidate, 'package.json'))) ?? installCandidates[0] ?? '.')
const PKG = 'dsh-deeppilot'
const ORIGINAL = '0.9.23'
const CONTROL = '0.9.24-hmrtest.0'
const FIXED = '0.9.24-hmrtest.1'
const NEXT = '0.9.24-hmrtest.2'
const SCOPES = ['sessions.read', 'prompt.send', 'sessions.manage', 'interactions.respond', 'notifications.register', 'schedule.manage', 'preview.open', 'hostweb.open']
const CHILDREN = new Set()
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
const redact = value => String(value).replace(/([?&]token=)[^\s&"']+/g, '$1[REDACTED]').replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[REDACTED]')
const errorInfo = error => ({ name: error?.name, message: redact(error?.message ?? error), stack: redact(error?.stack ?? '') })

function cleanEnvironment(scratch) {
  const env = {}
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'SYSTEMROOT', 'WINDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return {
    ...env, DSH_HOME: join(scratch, 'home'), DSH_TELEMETRY_DISABLED: '1',
    XDG_CONFIG_HOME: join(scratch, 'xdg-config'), XDG_CACHE_HOME: join(scratch, 'xdg-cache'),
    npm_config_userconfig: join(scratch, 'npmrc'), NPM_CONFIG_USERCONFIG: join(scratch, 'npmrc'),
    npm_config_globalconfig: join(scratch, 'global-npmrc'), NPM_CONFIG_GLOBALCONFIG: join(scratch, 'global-npmrc'),
    pnpm_config_userconfig: join(scratch, 'npmrc'), pnpm_config_globalconfig: join(scratch, 'global-npmrc'),
    pnpm_config_store_dir: join(scratch, 'pnpm-store'), pnpm_config_cache_dir: join(scratch, 'pnpm-cache'),
    pnpm_config_state_dir: join(scratch, 'pnpm-state'), pnpm_config_auto_install_peers: 'false',
    npm_config_registry: 'https://registry.npmjs.org/', pnpm_config_registry: 'https://registry.npmjs.org/',
    CI: '1', NO_COLOR: '1',
  }
}

async function command(program, args, options = {}) {
  const { logPath, timeoutMs = 180_000, ...spawnOptions } = options
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions })
    CHILDREN.add(child)
    let output = ''
    let timedOut = false
    const collect = chunk => {
      const text = redact(chunk.toString())
      output = (output + text).slice(-100_000)
      if (logPath) appendFileSync(logPath, text)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); CHILDREN.delete(child); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer); CHILDREN.delete(child)
      const result = { pid: child.pid, exitCode: code, signal, timedOut, output }
      if (code === 0 && !timedOut) resolveCommand(result)
      else reject(Object.assign(new Error(`${basename(program)} exited ${code} (${signal ?? ''})${timedOut ? ' timeout' : ''}: ${output.slice(-12_000)}`), { result }))
    })
  })
}

async function executable(name) {
  if (name.includes('/')) return name
  for (const folder of (process.env.PATH ?? '').split(':')) {
    const candidate = join(folder, name)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`Cannot locate ${name} in PATH`)
}

async function packageCopy(source, destination) {
  await mkdir(destination, { recursive: true })
  const manifest = await json(join(source, 'package.json'))
  await cp(join(source, 'package.json'), join(destination, 'package.json'))
  for (const declared of manifest.files) {
    // This package's manifest uses directory entries and locale/*.json only.
    const relative = declared.includes('*') ? dirname(declared) : declared
    assert(!relative.startsWith('/') && !relative.split('/').includes('..'))
    const from = join(source, relative)
    if (existsSync(from)) await cp(from, join(destination, relative), { recursive: true })
  }
  return manifest
}

async function preparePackages(scratch) {
  const metadataResponse = await fetch(`https://registry.npmjs.org/${PKG}/${ORIGINAL}`)
  assert.equal(metadataResponse.status, 200, 'published original metadata')
  const metadata = await metadataResponse.json()
  const download = await fetch(metadata.dist.tarball)
  assert.equal(download.status, 200, 'published original tarball')
  const originalBytes = Buffer.from(await download.arrayBuffer())
  assert.equal(hash(originalBytes, 'sha1'), metadata.dist.shasum, 'original npm SHA1')
  if (metadata.dist.integrity?.startsWith('sha512-')) assert.equal(`sha512-${hash(originalBytes, 'sha512', 'base64')}`, metadata.dist.integrity, 'original npm integrity')
  const artifacts = join(scratch, 'artifacts')
  await mkdir(artifacts, { recursive: true })
  const originalPath = join(artifacts, `${ORIGINAL}.tgz`)
  await writeFile(originalPath, originalBytes)
  const unpack = join(scratch, 'original')
  await mkdir(unpack)
  await command('/usr/bin/tar', ['-xzf', originalPath, '-C', unpack], { cwd: scratch })
  const originalRoot = join(unpack, 'package')
  assert.equal((await json(join(originalRoot, 'package.json'))).version, ORIGINAL)
  const packages = new Map([[ORIGINAL, { manifest: metadata, path: originalPath }]])
  for (const version of [CONTROL, FIXED, NEXT]) {
    const root = join(scratch, 'sources', version, 'package')
    const manifest = await packageCopy(version === CONTROL ? originalRoot : FIXED_ROOT, root)
    manifest.version = version
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    const path = join(artifacts, `${version}.tgz`)
    await command('/usr/bin/tar', ['-czf', path, '-C', dirname(root), 'package'], { cwd: scratch, env: { ...cleanEnvironment(scratch), COPYFILE_DISABLE: '1' } })
    packages.set(version, { manifest, path })
  }
  const originals = await readFile(join(originalRoot, 'cordis.patch.yml'), 'utf8')
  const fixedPatch = await readFile(join(scratch, 'sources', FIXED, 'package', 'cordis.patch.yml'), 'utf8')
  assert(originals.includes('deeppilot-directory-picker-browse'), 'baseline must carry old picker replacement')
  assert(!fixedPatch.includes('directory-picker'), 'fixed patch must leave official picker untouched')
  const facts = []
  for (const [version, item] of packages) {
    const bytes = await readFile(item.path)
    item.dist = { shasum: hash(bytes, 'sha1'), integrity: `sha512-${hash(bytes, 'sha512', 'base64')}` }
    facts.push({ version, path: item.path, bytes: bytes.length, sha256: hash(bytes), ...item.dist })
  }
  return { packages, facts, originalRegistry: metadata.dist.tarball, originalPatch: originals, fixedPatch }
}

async function reusePackages(source) {
  const previous = await json(join(source, 'evidence.json'))
  const packages = new Map()
  for (const fact of previous.packages) {
    const bytes = await readFile(fact.path)
    assert.equal(hash(bytes), fact.sha256, 'reused artifact SHA256')
    const root = fact.version === ORIGINAL ? join(source, 'original', 'package') : join(source, 'sources', fact.version, 'package')
    const manifest = await json(join(root, 'package.json'))
    assert.equal(manifest.version, fact.version)
    packages.set(fact.version, { manifest, path: fact.path, dist: { shasum: fact.shasum, integrity: fact.integrity } })
  }
  return { packages, facts: previous.packages, originalRegistry: previous.originalRegistry, originalPatch: previous.originalPatch, fixedPatch: previous.fixedPatch }
}

async function startRegistry(packages, evidence) {
  let base
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, base)
      evidence.push({ method: req.method, path: url.pathname, at: Date.now() })
      if (url.pathname === `/${PKG}` || url.pathname === `/${PKG}/`) {
        const versions = {}
        for (const [version, item] of packages) versions[version] = { ...item.manifest, dist: { ...item.dist, tarball: `${base}/${PKG}/-/${version}.tgz` } }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ name: PKG, 'dist-tags': { latest: NEXT }, versions, time: Object.fromEntries([...packages.keys()].map(version => [version, '2026-11-15T00:00:00.000Z'])) }))
        return
      }
      const version = /^\/dsh-deeppilot\/-\/(.+)\.tgz$/.exec(url.pathname)?.[1]
      if (version && packages.has(version)) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        createReadStream(packages.get(version).path).pipe(res)
        return
      }
      // Public dependency resolution only; incoming headers (including auth) are never forwarded.
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(404); res.end(); return }
      const upstream = await fetch(`https://registry.npmjs.org${url.pathname}${url.search}`, { headers: { accept: req.headers.accept ?? 'application/json' }, signal: AbortSignal.timeout(30_000) })
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch (error) { res.writeHead(502); res.end(JSON.stringify({ error: redact(error.message) })) }
  })
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  base = `http://127.0.0.1:${server.address().port}`
  return { base, close: () => new Promise(resolveClose => { server.closeAllConnections(); server.close(resolveClose) }) }
}

function identity(scopes) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
  const deviceId = hash(raw, 'sha256', 'base64url')
  return { privateKey, row: { deviceId, deviceName: 'Isolated directory HMR', appVersion: 'hmr-test', publicKey: raw.toString('base64url'), fingerprint: hash(raw), scopes, firstSeenTs: Date.now(), lastSeenTs: Date.now() } }
}

class Phone {
  constructor(WebSocket, endpoint, device) {
    this.seq = 0; this.pending = new Map(); this.frames = []; this.device = device
    this.socket = new WebSocket(endpoint.replace(/^http/, 'ws') + '/phone', { rejectUnauthorized: false, handshakeTimeout: 10_000 })
    this.socket.on('message', raw => {
      const frame = JSON.parse(String(raw)); this.frames.push(frame)
      const resolveFrame = this.pending.get(frame.id)
      if (resolveFrame) { this.pending.delete(frame.id); resolveFrame(frame) }
    })
    this.socket.on('error', () => {})
  }
  async wait(type) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const frame = this.frames.find(item => item.type === type)
      if (frame) return frame
      if (this.socket.readyState > 1) throw new Error(`WSS closed while waiting for ${type}`)
      await new Promise(resolveTick => setTimeout(resolveTick, 20))
    }
    throw new Error(`WSS timeout waiting for ${type}`)
  }
  async authenticate() {
    const challenge = (await this.wait('s2c.auth.challenge')).payload
    const row = this.device.row
    const fields = { ...challenge, deviceId: row.deviceId, deviceName: row.deviceName, appVersion: row.appVersion }
    const encoded = value => Buffer.from(value).toString('base64url')
    const canonical = ['deeppilot-auth-v2', `device-id:${encoded(fields.deviceId)}`, `nonce:${fields.nonce}`, `audience:${encoded(fields.audience)}`, `issued-at:${fields.issuedAt}`, `expires-at:${fields.expiresAt}`, `device-name:${encoded(fields.deviceName)}`, `app-version:${encoded(fields.appVersion)}`, 'resume-cursor:-'].join('\n')
    const signature = sign('sha256', Buffer.from(canonical), this.device.privateKey).toString('base64url')
    this.socket.send(JSON.stringify({ v: 2, type: 'c2s.auth.prove', ts: Date.now(), payload: { ...fields, signature } }))
    return this.wait('s2c.welcome')
  }
  request(type, payload = {}) {
    const id = `hmr-${++this.seq}`
    return new Promise((resolveFrame, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`WSS timeout: ${type}`)) }, 10_000)
      this.pending.set(id, frame => { clearTimeout(timer); resolveFrame(frame) })
      this.socket.send(JSON.stringify({ v: 2, type, id, ts: Date.now(), payload }))
    })
  }
  close() { this.socket.terminate() }
}

function httpJson(endpoint) {
  return new Promise((resolveResponse, reject) => {
    const request = https.get(endpoint, { rejectUnauthorized: false }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk })
      response.on('end', () => { try { resolveResponse({ status: response.statusCode, body: JSON.parse(body) }) } catch (error) { reject(error) } })
    })
    request.setTimeout(5_000, () => request.destroy(new Error('health timeout')))
    request.on('error', reject)
  })
}

async function worker(configPath) {
  const config = await json(configPath)
  const { scratch, profileName, fromVersion, toVersion, registry } = config
  const evidence = { case: config.case, fromVersion, toVersion, pid: process.pid, entryFile: SCRIPT, checks: [], updates: [], listeners: [], progress: [], moduleResolutions: [] }
  const moduleObserver = registerHooks({ resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context)
    if (specifier === PKG || (specifier === '../package.json' && context.parentURL?.includes('/dsh-deeppilot/'))) evidence.moduleResolutions.push({ specifier, parentURL: context.parentURL, url: result.url })
    return result
  } })
  const record = (name, ok, details = undefined) => { evidence.checks.push({ name, ok, ...(details === undefined ? {} : { details }) }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${config.case}: ${name}`) }
  const env = cleanEnvironment(scratch)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  process.chdir(scratch)
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    const original = console[method].bind(console)
    console[method] = (...args) => original(redact(format(...args)))
  }
  const installation = await json(join(INSTALL, 'package.json'))
  assert.equal(installation.version, '0.2.2-rc.3', 'exact DSH runtime')
  const requireInstall = createRequire(join(INSTALL, 'package.json'))
  const importInstalled = name => import(pathToFileURL(requireInstall.resolve(name)).href)
  const { runProfile, initializeProfileFromDefault } = await import(pathToFileURL(join(INSTALL, 'lib/profile-boot.js')).href)
  const { createLaunchEnvironmentSnapshot } = await importInstalled('@deepseek-ai/dsh-launch-environment')
  const { default: WebSocket } = await importInstalled('ws')
  const full = identity(SCOPES)
  const reader = identity(['sessions.read'])
  await mkdir(join(env.DSH_HOME, 'deeppilot'), { recursive: true, mode: 0o700 })
  await writeFile(join(env.DSH_HOME, 'deeppilot', 'devices-v2.json'), JSON.stringify({ devices: [full.row, reader.row] }), { mode: 0o600 })
  const fixturePath = join(scratch, 'fixture')
  await mkdir(join(fixturePath, 'Alpha'), { recursive: true })
  await mkdir(join(fixturePath, '.Hidden'), { recursive: true })
  await writeFile(join(fixturePath, 'ignored.txt'), 'synthetic fixture only\n')
  const fixture = fixturePath
  initializeProfileFromDefault(profileName, 'web', env.DSH_HOME)
  const profileDir = join(env.DSH_HOME, 'profiles', profileName)
  // Initial installation is cold; updates below are exclusively the real manager.
  if (config.pnpmArgs?.length) {
    const { runPluginCommand } = await importInstalled('@deepseek-ai/dsh-plugin-manager/operations')
    const initial = await runPluginCommand({ profile: profileName, dir: profileDir, installAnchor: join(INSTALL, 'package.json'), cwd: scratch }, ['add', `${PKG}@${fromVersion}`, '--save-exact', `--registry=${registry}`], { command: config.pnpm, args: config.pnpmArgs, env, execution: 'cli', outputBytes: 16384, lockWaitMs: 120000, lookupTimeoutMs: 120000, onOutput: text => appendFileSync(join(scratch, 'initial-install.log'), redact(text)) })
    assert.equal(initial.exitCode, 0, `cold install through the real dsh plugin command implementation: ${initial.output}`)
  } else {
    await command(process.execPath, [join(INSTALL, 'lib/bin.js'), 'plugin', '--profile', profileName, 'add', `${PKG}@${fromVersion}`, '--save-exact', `--registry=${registry}`], { cwd: scratch, env, logPath: join(scratch, 'initial-install.log') })
  }
  const overlay = join(scratch, 'test-overlay.yml')
  await writeFile(overlay, `- id: deeppilot\n  config:\n    local:\n      port: 3598\n    remote:\n      enabled: false\n    push:\n      provider: none\n- id: plugin-manager\n  config:\n    registry: ${JSON.stringify(registry)}\n    fallbackRegistries: []\n`)
  const sockets = new Set()
  const originalListen = net.Server.prototype.listen
  net.Server.prototype.listen = function (...args) {
    let originalHost
    let originalPort
    if (typeof args[0] === 'object' && args[0] !== null) {
      assert(!args[0].path, 'test only permits TCP listeners')
      originalHost = args[0].host; originalPort = args[0].port
      args[0] = { ...args[0], host: '127.0.0.1', port: 0 }
    } else if (typeof args[0] === 'number') {
      originalPort = args[0]
      originalHost = typeof args[1] === 'string' ? args[1] : undefined
      args[0] = 0
      if (typeof args[1] === 'string') args[1] = '127.0.0.1'
      else args.splice(1, 0, '127.0.0.1')
    } else throw new Error('Unexpected non-TCP listener in isolated test')
    sockets.add(this)
    this.once('listening', () => evidence.listeners.push({ requested: { host: originalHost, port: originalPort }, actual: this.address(), tls: this instanceof https.Server }))
    return originalListen.apply(this, args)
  }
  let ctx
  const objects = new WeakMap(); let nextObject = 0
  const objectId = observed => {
    // ctx.get returns a fresh tracing proxy; compare its real registered target.
    const value = observed?.[Symbol.for('cordis.original')] ?? observed
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null
    if (!objects.has(value)) objects.set(value, ++nextObject)
    return objects.get(value)
  }
  const picker = () => ({ picker: objectId(ctx.get('directoryPicker')), controller: objectId(ctx.get('directoryPickerController')), pickerClass: ctx.get('directoryPicker')?.constructor?.name })
  const livePhone = () => [...sockets].findLast(server => server instanceof https.Server && server.listening)
  const waitPhone = async expected => {
    let last
    for (let attempt = 0; attempt < 100; attempt++) {
      const server = livePhone()
      if (server) {
        try {
          const endpoint = `https://127.0.0.1:${server.address().port}`
          const health = await httpJson(endpoint + '/phone/health')
          if (health.status === 200 && health.body.dataPlane === true) return { endpoint, health }
          last = health
        } catch (error) { last = errorInfo(error) }
      }
      await new Promise(resolveTick => setTimeout(resolveTick, 50))
    }
    throw new Error(`phone health did not reach ${expected}: ${JSON.stringify(last)}`)
  }
  const wire = async (expected, label) => {
    const { endpoint, health } = await waitPhone(expected)
    record(`${label} health and runtime version`, health.body.serverVersion === expected, { expected, status: health.status, serverVersion: health.body.serverVersion, dataPlane: health.body.dataPlane })
    const phone = new Phone(WebSocket, endpoint, full)
    const restricted = new Phone(WebSocket, endpoint, reader)
    try {
      await phone.authenticate(); await restricted.authenticate()
      record(`${label} real WSS P-256 authentication`, true)
      const directory = await phone.request('c2s.directory.list', { path: fixture })
      record(`${label} directory lists only temporary fixture`, directory.type === 's2c.directory.listing' && directory.payload.path === fixture && directory.payload.entries.some(row => row.name === 'Alpha') && !directory.payload.entries.some(row => row.name === 'ignored.txt'), { type: directory.type, ...(directory.type === 's2c.error' ? { error: directory.payload } : { path: directory.payload.path, entries: directory.payload.entries }) })
      const workspacePath = join(fixture, 'Alpha')
      // Unlike directory listing, the workspace provider canonicalizes its path.
      const canonicalWorkspacePath = await realpath(workspacePath)
      const created = await phone.request('c2s.workspace.create', { path: workspacePath })
      record(`${label} adopts browsed directory as workspace`, created.type === 's2c.workspace.created' && created.payload?.workspace?.path === canonicalWorkspacePath, { type: created.type, path: created.payload?.workspace?.path, created: created.payload?.created, error: created.type === 's2c.error' ? created.payload : undefined })
      const repeated = await phone.request('c2s.workspace.create', { path: workspacePath })
      record(`${label} repeated workspace creation is idempotent`, repeated.type === 's2c.workspace.created' && repeated.payload?.created === false && repeated.payload?.workspace?.id === created.payload?.workspace?.id, { type: repeated.type, created: repeated.payload?.created })
      const workspaces = await phone.request('c2s.workspaces.list')
      record(`${label} workspace list contains adopted temporary directory`, workspaces.type === 's2c.workspaces.snapshot' && Array.isArray(workspaces.payload.workspaces) && workspaces.payload.workspaces.some(workspace => workspace.path === canonicalWorkspacePath), { type: workspaces.type, count: workspaces.payload?.workspaces?.length })
      const refused = await restricted.request('c2s.directory.list', { path: fixture })
      record(`${label} read-only device denied directory enumeration`, refused.type === 's2c.error' && refused.payload?.code === 'E_FORBIDDEN', { type: refused.type, error: refused.payload })
      const refusedPicker = await restricted.request('c2s.directory.pick')
      record(`${label} read-only device denied OS picker before invocation`, refusedPicker.type === 's2c.error' && refusedPicker.payload?.code === 'E_FORBIDDEN', { type: refusedPicker.type, error: refusedPicker.payload })
    } finally { phone.close(); restricted.close() }
  }
  const snapshot = async () => ({
    picker: picker(),
    bundles: (await ctx.get('pluginManager').listBundles()).filter(bundle => bundle.name === PKG),
    rows: (await ctx.get('pluginManager').listPlugins()).filter(row => /directory-picker|deeppilot/.test(row.moduleName)),
    loaderRows: [...ctx.loader.entries()].filter(entry => /directory-picker|deeppilot/.test(entry.options.name)).map(entry => ({ id: entry.id, name: entry.options.name, baseUrl: entry.parent.tree.ctx.baseUrl, contextBaseUrl: entry.fiber?.ctx?.baseUrl })),
    manifestCache: Object.entries(requireInstall.cache).filter(([path]) => path.includes('/dsh-deeppilot/') && path.endsWith('/package.json')).map(([path, module]) => ({ path, version: module.exports?.version })),
  })
  try {
    ;({ ctx } = await runProfile({ profile: profileName, environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]), patchFiles: [overlay], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'], packageManager: { command: config.pnpm, args: config.pnpmArgs ?? [], env } }))
    const manager = ctx.get('pluginManager')
    record('real HMR and manager mounted', Boolean(ctx.get('hmr') && manager))
    ctx.on('plugin-manager/update-state', event => evidence.progress.push(event))
    evidence.before = await snapshot()
    if (config.case === 'fixed-next') record('official picker and controller exist before update', Boolean(evidence.before.picker.picker && evidence.before.picker.controller), evidence.before.picker)
    await wire(fromVersion, 'before')
    const beforePicker = picker()
    const outcome = await manager.updateBundle(PKG, toVersion, { registry, requestId: config.case })
    evidence.updates.push(outcome)
    evidence.after = await snapshot()
    const applied = outcome.result.application === 'applied'
    if (config.case === 'old-control') record('old patch control reproduces duplicate directoryPicker registration', !applied && outcome.result.stage === 'enable' && /service ["']directoryPicker["'] has been registered/.test(outcome.result.error?.diagnostic ?? ''), outcome)
    else record('target update applied', applied, outcome)
    if (applied) {
      await wire(toVersion, 'after')
      const installed = await json(join(profileDir, 'node_modules', PKG, 'package.json'))
      record('installed disk version matches requested target', installed.version === toVersion, installed.version)
    } else {
      try { await wire(fromVersion, 'restore') } catch (error) { evidence.restoreProbe = errorInfo(error); record('original runtime restored after failed update', false, errorInfo(error)) }
    }
    if (config.case === 'fixed-next') {
      record('official picker identity preserved across update', JSON.stringify(beforePicker) === JSON.stringify(picker()), { before: beforePicker, after: picker() })
      const stable = picker()
      const disabled = await manager.setBundleEnabled(PKG, false)
      evidence.disable = disabled
      record('disable applied', disabled.application === 'applied', disabled)
      record('official picker identity preserved on disable', JSON.stringify(stable) === JSON.stringify(picker()), picker())
      const enabled = await manager.setBundleEnabled(PKG, true)
      evidence.enable = enabled
      record('enable applied', enabled.application === 'applied', enabled)
      record('official picker identity preserved on enable', JSON.stringify(stable) === JSON.stringify(picker()), picker())
      await wire(toVersion, 'reenabled')
      evidence.remove = await manager.removeBundle(PKG)
      record('remove applied', evidence.remove.application === 'applied', evidence.remove)
      record('official picker identity preserved on remove', JSON.stringify(stable) === JSON.stringify(picker()), picker())
      record('phone transport released after remove', !livePhone())
      evidence.afterRemove = await snapshot()
    }
  } catch (error) { evidence.failure = errorInfo(error); record('worker completed', false, errorInfo(error)) }
  finally {
    if (ctx) { try { await ctx.fiber.dispose() } catch (error) { evidence.cleanupError = errorInfo(error) } }
    for (const server of sockets) { server.closeAllConnections?.(); server.close() }
    net.Server.prototype.listen = originalListen
    moduleObserver.deregister()
    evidence.allListenersReleased = [...sockets].every(server => !server.listening)
    await writeFile(join(scratch, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  }
  return evidence
}

async function main() {
  if (process.argv[2] === '--worker') {
    const report = await worker(process.argv[3])
    process.exit(report.failure || report.cleanupError || report.checks.some(check => !check.ok) ? 1 : 0)
  }
  if (!process.argv.includes('--run') || !process.argv.includes('--artifacts-ready')) {
    console.log('Build the repair first, then run: node scripts/smoke-directory-hmr.mjs --run --artifacts-ready [--scratch /absolute/new-directory]')
    return
  }
  const selectedFlag = process.argv.indexOf('--cases')
  const selectedCases = selectedFlag === -1 ? undefined : process.argv[selectedFlag + 1]?.split(',')
  const caseNames = ['old-control', 'old-to-fixed', 'fixed-next']
  assert(selectedFlag === -1 || (selectedCases?.length > 0 && selectedCases.every(name => caseNames.includes(name))),
    '--cases must name one or more of old-control,old-to-fixed,fixed-next')
  const flag = process.argv.indexOf('--scratch')
  assert(flag === -1 || process.argv[flag + 1], '--scratch requires a new empty directory')
  const scratch = flag === -1 ? await mkdtemp(join(tmpdir(), 'directory-hmr-verify-')) : resolve(process.argv[flag + 1])
  await mkdir(scratch, { recursive: true })
  // Never replace an existing package.json or other user files, even when the
  // explicit path has no previous evidence.json. Check before the first write.
  assert.equal((await readdir(scratch)).length, 0, '--scratch must be a new empty directory')
  // Both entry file and cwd live outside the plugin package's self-reference.
  await writeFile(join(scratch, 'package.json'), JSON.stringify({ name: 'isolated-directory-hmr-harness', private: true, type: 'module' }))
  const workerScript = join(scratch, 'worker.mjs')
  await cp(SCRIPT, workerScript)
  const report = { runtime: { path: INSTALL, version: (await json(join(INSTALL, 'package.json'))).version }, fixedRoot: FIXED_ROOT, scratch, startedAt: new Date().toISOString(), packages: [], registryRequests: [], cases: [] }
  assert.equal(report.runtime.version, '0.2.2-rc.3')
  const artifactsFlag = process.argv.indexOf('--artifacts-from')
  const packages = artifactsFlag === -1 ? await preparePackages(scratch) : await reusePackages(resolve(process.argv[artifactsFlag + 1]))
  Object.assign(report, { packages: packages.facts, originalRegistry: packages.originalRegistry, originalPatch: packages.originalPatch, fixedPatch: packages.fixedPatch })
  const pnpmFlag = process.argv.indexOf('--pnpm-cli')
  const pnpmCli = pnpmFlag === -1 ? process.env.HMR_PNPM_CLI : process.argv[pnpmFlag + 1]
  const pnpm = pnpmCli ? process.execPath : await executable('pnpm')
  const pnpmArgs = pnpmCli ? [resolve(pnpmCli)] : []
  report.packageManager = { command: pnpm, args: pnpmArgs, version: (await command(pnpm, [...pnpmArgs, '--version'], { cwd: scratch, env: cleanEnvironment(scratch) })).output.trim() }
  const registry = await startRegistry(packages.packages, report.registryRequests)
  try {
    for (const scenario of [
      { case: 'old-control', fromVersion: ORIGINAL, toVersion: CONTROL },
      { case: 'old-to-fixed', fromVersion: ORIGINAL, toVersion: FIXED },
      { case: 'fixed-next', fromVersion: FIXED, toVersion: NEXT },
    ].filter(item => selectedCases === undefined || selectedCases.includes(item.case))) {
      const dir = join(scratch, scenario.case)
      await mkdir(dir)
      await writeFile(join(dir, 'npmrc'), 'registry=https://registry.npmjs.org/\nauto-install-peers=false\n')
      await writeFile(join(dir, 'global-npmrc'), '')
      const configPath = join(dir, 'config.json')
      await writeFile(configPath, JSON.stringify({ ...scenario, scratch: dir, profileName: `directory-${scenario.case}`, registry: registry.base, pnpm, pnpmArgs }))
      console.log(`Starting ${scenario.case}; evidence: ${dir}`)
      let processResult
      try { processResult = await command(process.execPath, [workerScript, '--worker', configPath], { cwd: dir, env: { ...cleanEnvironment(dir), HMR_DSH_INSTALL: INSTALL }, logPath: join(dir, 'runtime.log'), timeoutMs: 240_000 }) }
      catch (error) { processResult = error.result ?? errorInfo(error) }
      report.cases.push({ ...scenario, process: { pid: processResult.pid, exitCode: processResult.exitCode, signal: processResult.signal, timedOut: processResult.timedOut }, evidence: existsSync(join(dir, 'evidence.json')) ? await json(join(dir, 'evidence.json')) : { failure: { message: processResult.output?.slice(-12_000) ?? processResult.message } } })
      await writeFile(join(scratch, 'evidence.json'), JSON.stringify(report, null, 2) + '\n')
      console.log(`${scenario.case}: exit ${processResult.exitCode}; checks ${report.cases.at(-1).evidence.checks?.filter(check => check.ok).length ?? 0}/${report.cases.at(-1).evidence.checks?.length ?? 0}`)
    }
  } finally {
    await registry.close()
    for (const child of CHILDREN) child.kill('SIGTERM')
    report.finishedAt = new Date().toISOString()
    report.registryClosed = true
    await writeFile(join(scratch, 'evidence.json'), JSON.stringify(report, null, 2) + '\n')
  }
  const shortChange = change => change === undefined ? undefined : ({ application: change.application, stage: change.stage, version: change.version, error: change.error, warnings: change.warnings, packageExitCode: change.packageResult?.exitCode })
  const summary = {
    runtimeVersion: report.runtime.version, packageManager: report.packageManager, startedAt: report.startedAt, finishedAt: report.finishedAt,
    artifacts: report.packages.map(({ version, bytes, sha256 }) => ({ version, bytes, sha256 })),
    cases: report.cases.map(({ case: name, fromVersion, toVersion, process: result, evidence }) => ({
      case: name, fromVersion, toVersion, process: result,
      passed: evidence.checks?.filter(check => check.ok).length ?? 0, total: evidence.checks?.length ?? 0,
      checks: evidence.checks?.map(({ name, ok }) => ({ name, ok })),
      updates: evidence.updates?.map(update => ({ from: update.from, to: update.to, step: update.step, result: shortChange(update.result), restore: shortChange(update.restore) })),
      healthVersions: evidence.checks?.filter(check => check.name.endsWith('health and runtime version')).map(check => ({ name: check.name, ...check.details })),
      pickerIdentity: evidence.checks?.filter(check => check.name.includes('picker identity')).map(check => ({ name: check.name, ok: check.ok, details: check.details })),
      disable: shortChange(evidence.disable), enable: shortChange(evidence.enable), remove: shortChange(evidence.remove),
      allListenersReleased: evidence.allListenersReleased, failure: evidence.failure, cleanupError: evidence.cleanupError,
      allActualBindingsLoopback: evidence.listeners?.every(listener => listener.actual?.address === '127.0.0.1'),
      loadedPluginUrls: [...new Set(evidence.moduleResolutions?.filter(item => item.specifier === PKG).map(item => item.url) ?? [])],
    })),
    registryClosed: report.registryClosed,
  }
  await writeFile(join(scratch, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(`Evidence: ${join(scratch, 'evidence.json')}`)
  console.log(`Summary: ${join(scratch, 'summary.json')}`)
  process.exitCode = report.cases.some(item => item.process.exitCode !== 0) ? 1 : 0
}

for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { for (const child of CHILDREN) child.kill('SIGTERM'); process.exit(130) })
main().catch(error => { console.error(redact(error.stack ?? error)); process.exitCode = 1 })
