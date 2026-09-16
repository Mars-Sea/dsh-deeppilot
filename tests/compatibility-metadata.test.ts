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

// npm's prerelease rule: a version carrying a prerelease tag only satisfies a
// range when some comparator in that range carries a prerelease on the *same*
// major.minor.patch tuple. Neither `^0.1.5-rc.1` nor `>=0.1.5-rc.1` therefore
// admits any 0.1.6 prerelease, even though both look like they should. A
// disjunction is the only form that admits both prerelease lines while keeping
// a ceiling on the next minor line:
//   ^0.1.5-rc.1            -> 0.1.5-rc.* only
//   >=0.1.6-alpha.1 <0.2.0-0 -> every 0.1.6 prerelease and stable, < 0.2.0
const DSH_BASELINE = '^0.1.5-rc.1 || >=0.1.6-alpha.1 <0.2.0-0'
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

test('package metadata requires the supported DSH host family', () => {
  for (const name of DSH_PEERS) {
    assert.equal(packageJson.peerDependencies?.[name], DSH_BASELINE, name)
  }
  for (const name of HOST_RUNTIME_PEERS) {
    assert.equal(packageJson.peerDependenciesMeta?.[name]?.optional, true, `${name} optional peer`)
  }
})

test('the DSH peer range actually admits every supported prerelease line', () => {
  // Guards the failure mode this file exists to catch: a range that looks fine
  // but silently excludes the prerelease line people are testing against.
  const range = packageJson.peerDependencies?.['@deepseek-ai/dsh']
  assert.ok(range, '@deepseek-ai/dsh peer range present')
  for (const version of [
    '0.1.5-rc.1', '0.1.5-rc.2',
    '0.1.6-alpha.1', '0.1.6-beta.1', '0.1.6',
  ]) {
    assert.equal(semver.satisfies(version, range), true, `peer range must admit ${version}`)
  }
})

test('typechecked DSH packages stay inside the supported host family', () => {
  // These devDependencies are what `npm run typecheck` actually compiles
  // against, so they may float within the supported family (npm resolves the
  // highest matching release, which tracks the newest host line) but must
  // never resolve outside it. Assert the range, not one exact string.
  for (const name of [
    '@deepseek-ai/dsh-api-gateway',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-typert-protocol',
    '@deepseek-ai/dsh-typert-registry',
  ]) {
    const range = packageJson.devDependencies?.[name]
    assert.ok(range, `${name} devDependency present`)
    assert.equal(semver.subset(range, DSH_BASELINE), true, `${name} (${range}) inside ${DSH_BASELINE}`)
  }
})
