import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
if (Buffer.byteLength(source, 'utf8') < 1024) {
  throw new Error('client bundle is empty or unexpectedly small')
}
if (!source.trimStart().startsWith('window.__ModuleLoader__.load({')) {
  throw new Error('client bundle is missing the __ModuleLoader__.load wrapper')
}
if (!source.includes('id: "dsh-deeppilot"') || !source.includes('return module.exports;')) {
  throw new Error('client bundle is missing the plugin id or module export contract')
}

const allowed = new Set([
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
])
const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
const unexpected = [...new Set(requires.filter((name) => !allowed.has(name)))]

if (unexpected.length > 0) {
  throw new Error(`client bundle contains unavailable runtime requires: ${unexpected.join(', ')}`)
}
for (const expected of ['react', '@deepseek-ai/dsh-client-runtime/client']) {
  if (!requires.includes(expected)) throw new Error(`client bundle is missing expected runtime require: ${expected}`)
}
console.log(`client bundle runtime requires verified (${[...new Set(requires)].join(', ')})`)
