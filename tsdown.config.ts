import { defineConfig } from 'tsdown'

/**
 * Two bundles:
 *  - host: transpile src/index.ts to ESM under lib/ (the out-of-tree dsh
 *    bundle pattern). Peers stay external.
 *  - client: the browser settings-page bundle (lib/client.js). The host's
 *    client-modules scanner loads any bundle that declares `dsh.client` +
 *    `exports["./client"]`; the artifact must call
 *    `window.__ModuleLoader__.load({ id, factory })` — the same handoff shape
 *    the harness's own client packages emit. React stays external: the loader
 *    serves it from its platform module table.
 */
const host = defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'lib',
  clean: true,
  sourcemap: true,
  dts: true,
  // tsdown 0.23 起只认 outExtensions（0.22 已支持）；包入口固定指向 lib/index.js 与 lib/index.d.ts。
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})

const client = defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  dts: false,
  clean: false,
  deps: {
    // primitives 由 DSH 的平台模块表提供；必须取宿主组件，不能打包另一份 UI。
    neverBundle: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-primitives'],
    // Snapshot storage is vendored in src/client/snapshot-store.ts. Do not
    // externalize dsh-client-store: it is not published/seeded consistently
    // in 0.1.2 Web hosts.
    // DSH's browser module table only seeds platform packages. qrcode is a
    // private implementation dependency of this plugin and must travel inside
    // client.js instead of becoming a runtime require("qrcode").
    alwaysBundle: [/^qrcode(?:\/|$)/],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('dsh-deeppilot')}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

export default [host, client]
