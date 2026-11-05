import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'

/**
 * 控制器单测不渲染浏览器控件。官方 primitives 的 Node 入口包含 CSS 模块，
 * 因此将正式客户端源码编译为同一模块边界，在这里仅替换宿主 UI 依赖。
 * 若控制器测试误渲染宿主控件会立即失败；真实组件和样式由浏览器 E2E 验证。
 */
export function loadClientEntry(): typeof import('../src/client/index.ts') {
  const code = buildSync({
    entryPoints: [fileURLToPath(new URL('../src/client/index.ts', import.meta.url))],
    bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external',
  }).outputFiles[0]!.text
  const require = createRequire(import.meta.url)
  const module = { exports: {} }
  const execute = runInThisContext('(function(require,module,exports){\n' + code + '\n})', {
    filename: 'deeppilot-client-entry-test.cjs',
  }) as (require: (name: string) => unknown, module: { exports: unknown }, exports: unknown) => void
  execute((name) => {
    if (name !== '@deepseek-ai/dsh-client-ui-primitives') return require(name)
    const browserOnly = () => { throw new Error('宿主 UI 组件只能在浏览器夹具中渲染') }
    return { Switch: browserOnly, Button: browserOnly }
  }, module, module.exports)
  return module.exports as typeof import('../src/client/index.ts')
}
