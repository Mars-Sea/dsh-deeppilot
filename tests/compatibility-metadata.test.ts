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

// DeepPilot supports exactly the six DSH releases it has been audited against:
// `0.2.0-rc.2` (the `latest` channel), the three most recent releases of the
// `alpha` channel, and `0.2.1-rc.2` plus `0.2.1-rc.3` (the `next` channel,
// which moved from the former to the latter). DSH runs
// `evaluatePluginCompatibility` before composing a profile — on every start, not
// only on install — so every other host version refuses to activate this plugin
// by design, and a newly published DSH release needs this list widened
// deliberately. DSH_BASELINE is the fixed version this package builds and
// typechecks against, so it must stay an exact release, never a range.
const DSH_BASELINE = '0.2.0-rc.2'
const DSH_PEER_RANGE = '0.2.0-rc.2 || 0.2.1-alpha.3 || 0.2.1-alpha.4 || 0.2.1-alpha.5 || 0.2.1-rc.2 || 0.2.1-rc.3'
// DSH 0.2.1-alpha.4 and later decide on `engines.dsh` alone and ignore
// peerDependencies entirely; the same closed list must therefore appear in both
// places. Older hosts do not read `engines.dsh` at all and keep using the peer
// range above.
const DSH_ENGINES_RANGE = '0.2.0-rc.2 || 0.2.1-alpha.3 || 0.2.1-alpha.4 || 0.2.1-alpha.5 || 0.2.1-rc.2 || 0.2.1-rc.3'
// Audited hosts other than the build baseline. `0.2.1-rc.1` is deliberately
// absent: it was never audited as its own host, so it stays refused even though
// it sits between two admitted releases.
const DSH_AUDITED_HOSTS = ['0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-alpha.5', '0.2.1-rc.2', '0.2.1-rc.3']
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

test('package metadata declares exactly the audited host releases', () => {
  for (const name of DSH_PEERS) {
    assert.equal(packageJson.peerDependencies?.[name], DSH_PEER_RANGE, name)
  }
  for (const name of HOST_RUNTIME_PEERS) {
    assert.equal(packageJson.peerDependenciesMeta?.[name]?.optional, true, `${name} optional peer`)
  }
})

test('engines.dsh names the same closed host list as the peer range', () => {
  // DSH 0.2.1-alpha.4 and later evaluate `engines.dsh` alone and never fall
  // through to peerDependencies, so a range that drifted from the peer list would
  // silently change which hosts activate this plugin.
  assert.equal(packageJson.engines?.node, '>=22', 'node engine unchanged')
  const range = packageJson.engines?.dsh
  assert.ok(range, 'engines.dsh present')
  assert.equal(range, DSH_ENGINES_RANGE)
  for (const version of [DSH_BASELINE, ...DSH_AUDITED_HOSTS]) {
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, `engines.dsh must admit ${version}`)
  }
  // `0.2.1-rc.1` is the deliberate neighbour: the rc line reached this plugin one
  // release later, so the earlier rc stays refused. `0.2.1-rc.4` guards the other
  // side, so widening to rc.3 cannot silently admit the next rc either.
  for (const version of ['0.2.1-alpha.2', '0.2.0', '0.2.1-rc.1', '0.2.1-rc.4', '0.2.1', '0.3.0', '1.0.0']) {
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), false, `engines.dsh must exclude ${version}`)
  }
})

test('the DSH peer range admits every audited host and rejects every other version', () => {
  const range = packageJson.peerDependencies?.['@deepseek-ai/dsh']
  assert.ok(range, '@deepseek-ai/dsh peer range present')
  assert.equal(range, DSH_PEER_RANGE)
  // Exactly the six releases this plugin has been source-diffed and smoke-tested
  // against: the `latest` host, the three most recent `alpha` channel releases,
  // and the two `next` channel releases it has admitted in turn (`0.2.1-rc.2`,
  // then `0.2.1-rc.3`).
  for (const version of [DSH_BASELINE, ...DSH_AUDITED_HOSTS]) {
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, `peer range must admit ${version}`)
  }
  // Everything else, including versions that merely look close: an earlier alpha
  // of the same line, `0.2.1-rc.1` (the rc the list deliberately skipped), the rc
  // that follows `0.2.1-rc.3`, the eventual GA, and every 0.1.x/0.3.x/1.x
  // release. Widening this list is a deliberate act that follows an audit, never
  // an automatic consequence of a new DSH tag.
  for (const version of [
    '0.1.6',
    '0.1.7-alpha.2',
    '0.1.7-rc.2',
    '0.2.0-rc.1',
    '0.2.0-rc.3',
    '0.2.0-rc.20',
    '0.2.0',
    '0.2.1-alpha.1',
    '0.2.1-alpha.2',
    '0.2.1-rc.1',
    '0.2.1-rc.2.1',
    '0.2.1-rc.4',
    '0.2.1-rc.20',
    '0.2.1',
    '0.3.0-rc.1',
    '0.3.0',
    '1.0.0',
  ]) {
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), false, `peer range must exclude ${version}`)
  }
})

test('vendor peers admit the release each audited host vendors', () => {
  // cordis and schemastery are host-vendored third parties, so DSH's own peer
  // check ignores them; only npm's install-time peer resolution reads these, and
  // it runs without `includePrerelease`. Every audited host vendors one of these
  // three releases per package: the build baseline pins the oldest, the two
  // middle `alpha` hosts vendor the prerelease pair, and `0.2.1-alpha.5`,
  // `0.2.1-rc.2`, and `0.2.1-rc.3` vendor the promoted GA pair — so widening to
  // rc.3 added no new vendor version and these ranges stay untouched.
  const pinned: [string, string[]][] = [
    ['@deepseek-ai/cordis', ['4.0.4', '4.0.5-alpha.2', '4.0.5']],
    ['@deepseek-ai/schemastery', ['3.18.4', '3.18.5-alpha.2', '3.18.5']],
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

test('typechecked DSH packages are pinned to the audited host', () => {
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
