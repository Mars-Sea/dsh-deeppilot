import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

/**
 * 只监听回环地址的页面验收夹具。浏览器运行正式设置组件和样式，报告与操作由
 * tests/e2e/settings-fixture.ts 提供，不读取 DSH_HOME、不启动监听器或真实推送。
 */
const bundle = async (): Promise<string> => (await build({
  entryPoints: ['tests/e2e/settings-fixture.ts'], bundle: true, write: false,
  format: 'iife', platform: 'browser', target: 'es2022',
  define: { 'process.env.NODE_ENV': '"development"' },
})).outputFiles[0]!.text
const html = await readFile(new URL('../tests/e2e/settings-fixture.html', import.meta.url), 'utf8')
const port = Number(process.env.SETTINGS_PREVIEW_PORT ?? 4781)
const server = createServer(async (req, res) => {
  if (req.url?.split('?')[0] === '/fixture.js') {
    try {
      // 已启动的预览可被测试复用；按加载重新构建，避免验收旧代码。
      const script = await bundle()
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(script)
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
