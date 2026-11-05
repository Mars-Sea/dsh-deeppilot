import type { Plugin } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 独立浏览器夹具没有 DSH 的平台模块表。官方包的 barrel 还包含 Markdown 等
 * 渲染器及其宿主依赖，因此只加载该固定版本包内原样的 Switch 区段和原始 CSS。
 * 不复制组件或样式到项目，也不重写它们；生产构建完全不使用此测试插件。
 */
export const settingsHostUi: Plugin = {
  name: 'settings-official-host-ui',
  setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({
      path: 'official-switch', namespace: 'settings-host-ui',
    }))
    build.onLoad({ filter: /^official-switch$/, namespace: 'settings-host-ui' }, async () => {
      const root = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-client-ui-primitives/package.json')))
      const source = await readFile(join(root, 'lib/index.js'), 'utf8')
      const region = /\/\/#region lib\/types\/Switch\.js\n([\s\S]*?)\/\/#endregion/.exec(source)?.[1]
      const cssAlias = /import (\S+) from "\.\/Switch\.module\.css"/.exec(source)?.[1]
      if (!region || !cssAlias) throw new Error('官方 Switch 包的构建形状变化，需重新核对验收夹具')
      return {
        contents: [
          'import { jsx } from "react/jsx-runtime";',
          'import clsx from "clsx";',
          `import ${cssAlias} from ${JSON.stringify(join(root, 'lib/Switch.module.css'))};`,
          region,
          'export { Switch };',
        ].join('\n'),
        loader: 'js', resolveDir: process.cwd(),
      }
    })
  },
}
