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
])
const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
const unexpected = [...new Set(requires.filter((name) => !allowed.has(name)))]

if (unexpected.length > 0) {
  throw new Error(`client bundle contains unavailable runtime requires: ${unexpected.join(', ')}`)
}
if (!requires.includes('react')) {
  throw new Error('client bundle is missing its React runtime require')
}
for (const removed of ['@deepseek-ai/dsh-client-runtime/client', '@deepseek-ai/dsh-client-store']) {
  if (requires.includes(removed)) throw new Error(`client bundle retained unavailable runtime require: ${removed}`)
}
console.log(`client bundle runtime requires verified (${[...new Set(requires)].join(', ')})`)
