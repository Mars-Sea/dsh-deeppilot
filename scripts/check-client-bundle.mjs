import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const allowed = new Set([
  'react',
  '@deepseek-ai/dsh-client-runtime/client',
])
const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])
const unexpected = [...new Set(requires.filter((name) => !allowed.has(name)))]

if (unexpected.length > 0) {
  throw new Error(`client bundle contains unavailable runtime requires: ${unexpected.join(', ')}`)
}
console.log(`client bundle runtime requires verified (${[...new Set(requires)].join(', ')})`)
