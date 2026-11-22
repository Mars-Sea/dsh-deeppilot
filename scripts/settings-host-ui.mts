import type { Plugin } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 用固定版本发布包中的组件源码和 CSS 构建独立验收夹具。
 * DSH 的浏览器 bundle 依赖宿主模块表，生产构建仍由 DSH 加载。
 */
export const settingsHostUi: Plugin = {
  name: 'settings-official-host-ui',
  setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({
      path: 'official-controls', namespace: 'settings-host-ui',
    }))
    build.onLoad({ filter: /^official-controls$/, namespace: 'settings-host-ui' }, () => {
      const root = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-client-ui-primitives/package.json')))
      return {
        contents: ['Switch', 'Button'].map(name => `export { ${name} } from './${name}.tsx'`).join('\n'),
        loader: 'js',
        resolveDir: join(root, 'src'),
      }
    })
  },
}
