import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import semver from 'semver'

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  devDependencies?: Record<string, string>
}

// The floor of the audited 0.2.x line: the lowest host version DeepPilot has
// been source-diffed and smoke-tested against. DSH_PEER_RANGE (below) trusts
// every later 0.2.x host up to, but excluding, 0.3.0 without a further audit;
// DSH_BASELINE is only the fixed version this package builds and typechecks
// against, so it must stay an exact release, never a range.
const DSH_BASELINE = '0.2.0-rc.2'
const DSH_PEER_RANGE = '>=0.2.0-rc.2 <0.3.0-0'
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

test('package metadata declares the audited 0.2.x peer range', () => {
  for (const name of DSH_PEERS) {
    assert.equal(packageJson.peerDependencies?.[name], DSH_PEER_RANGE, name)
  }
  for (const name of HOST_RUNTIME_PEERS) {
    assert.equal(packageJson.peerDependenciesMeta?.[name]?.optional, true, `${name} optional peer`)
  }
})

test('the DSH peer range admits the audited 0.2.x line and rejects everything outside it', () => {
  const range = packageJson.peerDependencies?.['@deepseek-ai/dsh']
  assert.ok(range, '@deepseek-ai/dsh peer range present')
  assert.equal(range, DSH_PEER_RANGE)
  // The floor (DSH_BASELINE) and every later 0.2.x host — future rc's and the
  // eventual 0.2.0 GA — install without a further audit or a manual version
  // bump; a real source diff is still expected per DSH release (see
  // docs/DSH_RELEASE_MEMORY.md), but it no longer gates installability.
  for (const version of [
    DSH_BASELINE,
    '0.2.0-rc.3',
    '0.2.0-rc.20',
    '0.2.0',
    '0.2.1',
    '0.2.1-rc.1',
  ]) {
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, `peer range must admit ${version}`)
  }
  // 0.1.7-rc.2 (the previous plugin baseline) and every earlier 0.1.x are
  // outside the audited line. 0.3.0 and its prereleases are the next
  // audit boundary: minor bumps below 1.0.0 may contain breaking changes,
  // so they must not install without a deliberate range widening.
  for (const version of [
    '0.1.6',
    '0.1.7-alpha.2',
    '0.1.7',
    '0.1.7-rc.1',
    '0.1.7-rc.2',
    '0.2.0-rc.1',
    '0.3.0-rc.1',
    '0.3.0',
    '1.0.0',
  ]) {
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), false, `peer range must exclude ${version}`)
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
