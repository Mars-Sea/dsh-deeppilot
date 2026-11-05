import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { settingsHostUi } from './settings-host-ui.mts'

/**
 * 只监听回环地址的页面验收夹具。浏览器运行正式设置组件和样式，报告与操作由
 * tests/e2e/settings-fixture.ts 提供，不读取 DSH_HOME、不启动监听器或真实推送。
 */
const bundle = async () => (await build({
  entryPoints: ['tests/e2e/settings-fixture.ts'], bundle: true, write: false,
  format: 'iife', platform: 'browser', target: 'es2022',
  outfile: 'fixture.js', loader: { '.css': 'local-css' }, plugins: [settingsHostUi],
  define: { 'process.env.NODE_ENV': '"development"' },
})).outputFiles
const html = await readFile(new URL('../tests/e2e/settings-fixture.html', import.meta.url), 'utf8')
const port = Number(process.env.SETTINGS_PREVIEW_PORT ?? 4781)
const server = createServer(async (req, res) => {
  const asset = req.url?.split('?')[0]
  if (asset === '/fixture.js' || asset === '/fixture.css') {
    try {
      // 已启动的预览可被测试复用；按加载重新构建，避免验收旧代码。
      const files = await bundle()
      const css = asset.endsWith('.css')
      const output = files.find((file) => file.path.endsWith(css ? '.css' : '.js'))
      if (!output) throw new Error('验收夹具缺少官方组件产物')
      res.writeHead(200, { 'content-type': css ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(output.text)
    } catch (error) {
      console.error(error)
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('设置页验收夹具构建失败')
    }
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
  }
})
server.listen(port, '127.0.0.1', () => console.log(`Settings fixture: http://127.0.0.1:${port}`))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)))
