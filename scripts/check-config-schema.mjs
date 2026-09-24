/**
 * Compose cordis.patch.yml against a minimal DSH profile and assert that the
 * exported Config schema survives the pinned 0.1.7-rc.1 loader.
 *
 * Uses `dsh --dump-config-schema`: the CLI imports
 * the plugin's Config schema without mounting anything, so this guards three
 * regressions at once — the patch still composes, the plugin still imports
 * under a current host, and the schema still projects.
 *
 * The `sdk-minimal` template keeps this check scoped to the plugin entry.
 *
 * Requires network on first run (npx downloads the pinned DSH CLI).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_VERSION = '0.1.7-rc.1'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// The profile must live INSIDE this package tree: the loader resolves the
// bare specifier "dsh-deeppilot" from the profile's cordis.yml, where Node's
// package self-reference (name + exports in our package.json) is what makes
// it resolve to this working copy instead of an installed copy.
const home = mkdtempSync(join(root, '.dsh-home-'))
const outFile = join(tmpdir(), `deeppilot-config-schema-${process.pid}.json`)

try {
  const run = spawnSync(
    'npx',
    [
      '--yes',
      `@deepseek-ai/dsh@${DSH_VERSION}`,
      '--profile', 'deeppilot-ci',
      '--from-default-profile', 'sdk-minimal',
      '--dump-config-schema',
      '--patch', 'cordis.patch.yml',
    ],
    {
      cwd: root,
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
      // npx is a .cmd on Windows; shell keeps the spawn portable there.
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  writeFileSync(outFile, run.stdout ?? '')
  if (run.status !== 0) {
    process.stderr.write(run.stderr ?? '')
    throw new Error(`dsh --dump-config-schema exited ${run.status ?? 'by signal ' + run.signal}`)
  }

  let dump
  try {
    dump = JSON.parse(readFileSync(outFile, 'utf8'))
  } catch (error) {
    process.stderr.write(run.stderr ?? '')
    throw new Error(`dsh --dump-config-schema produced no schema document: ${String(error)}`)
  }

  const xCordis = dump?.['x-cordis']
  if (!xCordis || !Array.isArray(xCordis.entries)) {
    throw new Error('schema document is missing x-cordis.entries')
  }

  const ours = xCordis.entries.filter((entry) => entry.id === 'deeppilot')
  if (ours.length !== 1) {
    throw new Error(`expected exactly one "deeppilot" entry, found ${ours.length}`)
  }
  const entry = ours[0]
  if (entry.name !== 'dsh-deeppilot') {
    throw new Error(`"deeppilot" entry resolves to ${JSON.stringify(entry.name)}, expected "dsh-deeppilot"`)
  }
  if (entry.status !== 'schema') {
    const related = (xCordis.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.path === entry.path)
      .map((diagnostic) => `${diagnostic.level}: ${diagnostic.message}`)
      .join('; ')
    throw new Error(
      `deeppilot config projection status is ${JSON.stringify(entry.status)}, expected "schema"`
        + (related ? ` (${related})` : ''),
    )
  }
  const defKey = String(entry.configRef ?? '').replace(/^#\/\$defs\//, '')
  if (defKey === '' || dump.$defs?.[defKey] === undefined) {
    throw new Error(`deeppilot configRef ${JSON.stringify(entry.configRef)} does not resolve in $defs`)
  }

  // Entry-level diagnostics for our rows must stay clean; diagnostics for
  // other packages are the host template's concern, not this check's.
  const oursPath = entry.path
  const bad = (xCordis.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.level === 'error' && diagnostic.path === oursPath,
  )
  if (bad.length > 0) {
    throw new Error(`deeppilot entry carries errors: ${bad.map((d) => d.message).join('; ')}`)
  }

  // The fields the settings surface writes must arrive annotated volatile —
  // without that annotation a 0.1.7 host refuses every settings write for the
  // field, and the fields that must keep their remount semantics must NOT be
  // marked. This proves the actual schema through the rc.1 dumper.
  const def = dump.$defs?.[defKey]
  const branches = Array.isArray(def?.anyOf) ? def.anyOf : [def]
  const props = branches.map((branch) => branch?.properties).find((candidate) => candidate && 'enabled' in candidate)
  if (props === undefined) {
    throw new Error('deeppilot config schema exposes no object properties to verify')
  }
  const isVolatile = (key) => props[key]?.['x-cordis']?.volatile === true
  for (const key of ['enabled', 'local', 'remote', 'debug']) {
    if (!isVolatile(key)) {
      throw new Error(`${key} must be declared volatile so 0.1.7 settings writes are accepted`)
    }
  }
  for (const key of ['devicesPath', 'historyBufferMax', 'push']) {
    if (isVolatile(key)) {
      throw new Error(`${key} must stay non-volatile so its edits keep remounting the instance`)
    }
  }

  console.log(`config schema verified against @deepseek-ai/dsh@${DSH_VERSION} (${entry.path} → $defs/${defKey}, volatile fields pinned)`)
} finally {
  rmSync(home, { recursive: true, force: true })
  rmSync(outFile, { force: true })
}
