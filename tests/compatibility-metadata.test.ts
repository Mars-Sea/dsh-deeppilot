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

const DSH_BUILD_VERSION = '0.2.3-alpha.2'
const DSH_RANGE = '>=0.2.2-rc.1 <0.2.3-0 || >=0.2.3-alpha.1 <0.2.4-0'
const DSH_ADMITTED = [
  '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3', '0.2.2-rc.4', '0.2.2-rc.5', '0.2.2',
  '0.2.3-alpha.1', DSH_BUILD_VERSION, '0.2.3-alpha.3', '0.2.3-rc.1', '0.2.3',
]
const DSH_REFUSED = [
  '0.1.7-rc.2',
  '0.2.1-rc.5',
  '0.2.2-alpha.2',
  '0.2.2-alpha.3',
  '0.2.3-0',
  '0.2.3-alpha.0',
  '0.2.4-alpha.1',
  '0.2.4',
  '0.3.0-0',
  '0.3.0-rc.1',
  '0.3.0',
  '1.0.0',
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

test('DSH peers declare the same supported versions as the engine', () => {
  for (const name of DSH_PEERS) {
    assert.equal(packageJson.peerDependencies?.[name], DSH_RANGE, name)
  }
  for (const name of HOST_RUNTIME_PEERS) {
    assert.equal(packageJson.peerDependenciesMeta?.[name]?.optional, true, `${name} optional peer`)
  }
})

test('DSH and npm both admit the RC and Alpha series in the published range', () => {
  assert.equal(packageJson.engines?.node, '>=22')
  for (const range of [packageJson.engines?.dsh, packageJson.peerDependencies?.['@deepseek-ai/dsh']]) {
    assert.equal(range, DSH_RANGE)
    for (const version of DSH_ADMITTED) {
      assert.equal(semver.satisfies(version, range), true, `npm peer check: ${version}`)
      assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, `DSH Host check: ${version}`)
    }
    for (const version of DSH_REFUSED) {
      assert.equal(semver.satisfies(version, range, { includePrerelease: true }), false, version)
    }
  }
})

test('vendor peer ranges cover the RC and Alpha runtime libraries', () => {
  for (const [name, version, rcVersion] of [
    ['@deepseek-ai/cordis', '4.2.0-alpha.1', '4.1.0'],
    ['@deepseek-ai/schemastery', '3.20.0-alpha.1', '3.19.0'],
  ] as const) {
    assert.equal(packageJson.devDependencies?.[name], version)
    const range = packageJson.peerDependencies?.[name]
    assert.ok(range, name)
    assert.equal(semver.satisfies(version, range), true, name)
    assert.equal(semver.satisfies(rcVersion, range), true, name)
  }
})

test('typechecked DSH packages are pinned to the audited Alpha release', () => {
  for (const name of [
    '@deepseek-ai/dsh-api-gateway',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-typert-protocol',
    '@deepseek-ai/dsh-typert-registry',
  ]) {
    const range = packageJson.devDependencies?.[name]
    assert.ok(range, `${name} devDependency present`)
    assert.equal(range, DSH_BUILD_VERSION, name)
  }
})
