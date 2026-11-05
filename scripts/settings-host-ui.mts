import type { Plugin } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 独立浏览器夹具没有 DSH 的平台模块表。官方包的 barrel 还包含 Markdown 等
 * 渲染器及其宿主依赖，因此只加载该固定版本包内原样的控件区段和原始 CSS。
 * 不复制组件或样式到项目，也不重写它们；生产构建完全不使用此测试插件。
 */
export const settingsHostUi: Plugin = {
  name: 'settings-official-host-ui',
  setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({
      path: 'official-controls', namespace: 'settings-host-ui',
    }))
    build.onLoad({ filter: /^official-controls$/, namespace: 'settings-host-ui' }, async () => {
      const root = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-client-ui-primitives/package.json')))
      const source = await readFile(join(root, 'lib/index.js'), 'utf8')
      const controls = ['Switch', 'Button'].map((name) => {
        const region = new RegExp(`//\\#region lib/types/${name}\\.js\\n([\\s\\S]*?)//\\#endregion`).exec(source)?.[1]
        const cssAlias = new RegExp(`import (\\S+) from "\\./${name}\\.module\\.css"`).exec(source)?.[1]
        if (!region || !cssAlias) throw new Error(`官方 ${name} 包的构建形状变化，需重新核对验收夹具`)
        return `import ${cssAlias} from ${JSON.stringify(join(root, `lib/${name}.module.css`))};\n${region}`
      })
      return {
        contents: [
          'import { jsx, jsxs } from "react/jsx-runtime";',
          'import { forwardRef } from "react";',
          'import clsx from "clsx";',
          ...controls,
          'export { Switch, Button };',
        ].join('\n'),
        loader: 'js', resolveDir: process.cwd(),
      }
    })
  },
}
