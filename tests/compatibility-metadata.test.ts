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

const DSH_BASELINE = '0.2.0-rc.1'
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

test('package metadata requires the audited DSH host', () => {
  for (const name of DSH_PEERS) {
    assert.equal(packageJson.peerDependencies?.[name], DSH_BASELINE, name)
  }
  for (const name of HOST_RUNTIME_PEERS) {
    assert.equal(packageJson.peerDependenciesMeta?.[name]?.optional, true, `${name} optional peer`)
  }
})

test('the DSH peer range admits only the audited host', () => {
  const range = packageJson.peerDependencies?.['@deepseek-ai/dsh']
  assert.ok(range, '@deepseek-ai/dsh peer range present')
  assert.equal(semver.satisfies(DSH_BASELINE, range), true)
  // 0.1.7-rc.2 is the previously audited baseline: an exact pin must reject
  // it, and so must every earlier 0.1.x plus a hypothetical 0.2.0 GA, so the
  // plugin can never activate on an unaudited host.
  for (const version of [
    '0.1.6',
    '0.1.7-alpha.2',
    '0.1.7',
    '0.1.7-rc.1',
    '0.1.7-rc.2',
    '0.2.0',
  ]) {
    assert.equal(semver.satisfies(version, range), false, `peer range must exclude ${version}`)
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
