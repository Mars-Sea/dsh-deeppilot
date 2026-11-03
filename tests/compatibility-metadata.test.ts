import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import semver from 'semver'

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  engines?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  devDependencies?: Record<string, string>
}

// Since 2026-10-30 the DSH compatibility declaration is no longer a closed set of
// individually audited releases; it is one rolling range:
//
//   >=0.2.1-rc.5 <0.3.0-0
//
// The lower bound is the newest `rc` release at decision time (npm `latest` and
// `next` both point at `0.2.1-rc.5`), and everything after it inside `0.2.x` is
// admitted automatically — later rc releases, `0.2.1` GA, the current `alpha`
// channel release `0.2.2-alpha.2` (it sorts after `0.2.1-rc.5`, so the same
// clause covers the alpha line), later alphas, later rc releases of `0.2.2`,
// `0.2.2` GA and `0.2.3`. `<0.3.0-0` keeps the manual audit gate at the next
// minor boundary: `0.x` minor bumps may contain breaking changes, so `0.3.0`
// and its prereleases stay refused until a fresh audit. Writing `<0.3.0-0`
// rather than `<0.3.0` matters because DSH evaluates the range with
// `semver.satisfies(version, range, { includePrerelease: true })`, where
// `<0.3.0` would let `0.3.0-rc.1` through.
//
// DSH runs `evaluatePluginCompatibility` before composing a profile on every
// start, not only on install. Since 0.2.1-alpha.4 a manifest's own `engines.dsh`
// decides alone and peerDependencies are ignored; older hosts know only the peer
// range, and npm reads it at install time. Both declarations must therefore
// carry the identical range.
//
// Trade-off accepted with the user: an unaudited DSH prerelease inside the
// range activates without a per-release source audit. The visible "refuses to
// start on an unaudited host" gate now only applies below the lower bound and
// at `0.3.0`. The policy change and its reasoning live in the maintainers'
// local decision record `docs/adr/0001-dsh-compatibility-policy.md`.
const DSH_RANGE = '>=0.2.1-rc.5 <0.3.0-0'
// The fixed release this package builds and typechecks against. It is the lower
// bound of the supported range and must stay an exact release, never a range.
const DSH_BASELINE = '0.2.1-rc.5'
// Every host version the rolling range must admit. The rc line and the alpha
// line are both represented, including the GA release each line leads to.
const DSH_ADMITTED = [
  DSH_BASELINE,
  '0.2.1-rc.6',
  '0.2.1-rc.10',
  '0.2.1-rc.50',
  '0.2.1',
  '0.2.2-alpha.2',
  '0.2.2-alpha.3',
  '0.2.2-alpha.20',
  '0.2.2-alpha.2.1',
  '0.2.2-rc.1',
  '0.2.2-rc.2',
  '0.2.2',
  '0.2.3-alpha.1',
  '0.2.3',
]
// Every host version the rolling range must still refuse. The first block is the
// seven releases the previous closed list admitted; they are below the new lower
// bound and are deliberately dropped. The second block covers the neighbours
// around the lower bound (`0.2.1-rc.4.x`, `0.2.1-RC.5`) so a lowering of the
// bound cannot slip through unnoticed. The third block is the `0.3.0` audit gate.
const DSH_REFUSED = [
  '0.2.0-rc.2',
  '0.2.1-alpha.3',
  '0.2.1-alpha.4',
  '0.2.1-alpha.5',
  '0.2.1-rc.2',
  '0.2.1-rc.3',
  '0.2.1-rc.4',
  '0.2.1-alpha.1',
  '0.2.1-alpha.2',
  '0.2.0-rc.1',
  '0.2.0',
  '0.1.7-rc.2',
  '0.2.1-rc.4.0',
  '0.2.1-rc.4.1',
  '0.2.1-RC.5',
  '0.2.1.1',
  '0.3.0-0',
  '0.3.0-rc.1',
  '0.3.0',
  '0.4.0-alpha.1',
  '1.0.0',
  '2.0.0-rc.1',
]
// Prereleases that sort after the lower bound but were never audited. A rolling
// range admits them by construction: any version greater than `0.2.1-rc.5` and
// lower than `0.3.0-0` is inside. This list is pinned so the consequence stays
// visible and cannot be mistaken for a bug when such a release appears.
const DSH_ADMITTED_WITHOUT_AUDIT = [
  '0.2.2-alpha.0',
  '0.2.2-alpha.1',
  '0.2.2-beta.1',
  '0.2.2-0',
  '0.2.2-ALPHA.2',
]
const DSH_PEERS = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-typert-registry',
]
const HOST_RUNTIME_PEERS = [
  '@deepseek-ai/cordis',
  ...DSH_PEERS,
  '@deepseek-ai/schemastery',
  'react',
]

test('package metadata declares the rolling compatibility range', () => {
  for (const name of DSH_PEERS) {
    assert.equal(packageJson.peerDependencies?.[name], DSH_RANGE, name)
  }
  for (const name of HOST_RUNTIME_PEERS) {
    assert.equal(packageJson.peerDependenciesMeta?.[name]?.optional, true, `${name} optional peer`)
  }
})

test('engines.dsh names the same rolling range as the peer declarations', () => {
  // DSH 0.2.1-alpha.4 and later evaluate `engines.dsh` alone and never fall
  // through to peerDependencies, so a range that drifted from the peer list would
  // silently change which hosts activate this plugin.
  assert.equal(packageJson.engines?.node, '>=22', 'node engine unchanged')
  const range = packageJson.engines?.dsh
  assert.ok(range, 'engines.dsh present')
  assert.equal(range, DSH_RANGE)
  for (const version of DSH_ADMITTED) {
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, `engines.dsh must admit ${version}`)
  }
})

test('the range admits the newest rc and alpha lines and everything after them', () => {
  const range = packageJson.peerDependencies?.['@deepseek-ai/dsh']
  assert.ok(range, '@deepseek-ai/dsh peer range present')
  assert.equal(range, DSH_RANGE)
  for (const version of DSH_ADMITTED) {
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, `peer range must admit ${version}`)
  }
  // The current alpha channel release must stay admitted: the user asked for
  // "the newest test channel release and everything after it" in addition to the
  // newest rc line. It sorts after the rc lower bound, so one clause covers both.
  assert.equal(semver.satisfies('0.2.2-alpha.2', range, { includePrerelease: true }), true, 'current alpha channel release stays admitted')
})

test('the range refuses the previous closed list, the boundary neighbours, and 0.3.0+', () => {
  const range = packageJson.engines?.dsh
  assert.ok(range, 'engines.dsh present')
  for (const version of DSH_REFUSED) {
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), false, `engines.dsh must exclude ${version}`)
  }
})

test('a rolling range admits unaudited prereleases above the lower bound', () => {
  // This is the documented consequence of the 2026-10-30 policy, not an
  // accident: the range cannot express "the newest rc and newest alpha plus
  // their successors" without also letting through prereleases that sort between
  // them. `0.2.2-alpha.1` never shipped, but a future `0.2.2-beta.1` would.
  const range = packageJson.engines?.dsh
  assert.ok(range, 'engines.dsh present')
  for (const version of DSH_ADMITTED_WITHOUT_AUDIT) {
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, `rolling range admits ${version} by construction`)
  }
  // npm resolves peer ranges without `includePrerelease`, so an alpha host only
  // satisfies the prerelease clause when it shares the range's major.minor.patch.
  // Every DSH peer is an optional peer, so this affects install-time warnings,
  // not activation; DSH's own check uses the option above.
  assert.equal(semver.satisfies('0.2.1-rc.5', range), true)
  assert.equal(semver.satisfies('0.2.2-alpha.2', range), false)
})

test('vendor peers admit the release each supported host line vendors', () => {
  // cordis and schemastery are host-vendored third parties, so DSH's own peer
  // check ignores them; only npm's install-time peer resolution reads these.
  // Every DSH host line vendors one of these releases per package: the 0.2.0
  // baseline pins the oldest pair, the 0.2.1 alpha hosts vendor the prerelease
  // pair, `0.2.1-alpha.5` through `0.2.1-rc.5` vendor the promoted GA pair, and
  // `0.2.2-alpha.2` moves the pair to `cordis 4.0.6-alpha.1` /
  // `schemastery 3.18.6-alpha.1`. The prerelease clauses are appended, never
  // substituted: the GA pair is still vendored by every earlier host line.
  const pinned: [string, string[]][] = [
    ['@deepseek-ai/cordis', ['4.0.4', '4.0.5-alpha.2', '4.0.5', '4.0.6-alpha.1']],
    ['@deepseek-ai/schemastery', ['3.18.4', '3.18.5-alpha.2', '3.18.5', '3.18.6-alpha.1']],
  ]
  for (const [name, versions] of pinned) {
    const range = packageJson.peerDependencies?.[name]
    assert.ok(range, `${name} peer range present`)
    for (const version of versions) {
      assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, `${name} peer must admit ${version}`)
    }
    assert.equal(semver.satisfies('9.9.9', range, { includePrerelease: true }), false, `${name} peer must reject an unaudited major`)
  }
})

test('typechecked DSH packages are pinned to the supported baseline', () => {
  for (const name of [
    '@deepseek-ai/dsh-api-gateway',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-typert-protocol',
    '@deepseek-ai/dsh-typert-registry',
  ]) {
    const range = packageJson.devDependencies?.[name]
    assert.ok(range, `${name} devDependency present`)
    assert.equal(range, DSH_BASELINE, name)
  }
})
