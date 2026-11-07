# Upstream Discussion draft — `updateBundle` HMR replace conflicts with `directory-picker`

> Status: **submitted 2026-11-07** → https://github.com/deepseek-ai/deepseek-harness/discussions/12510
> (discussion `#12510`, category `q-a` / `Q&A`, author `Mars-Sea`). The English body below is the
> text that was posted; the Chinese notes at the end were **not** posted.
> That repo has Issues disabled and README:45 asks for bug reports via Discussions; recent
> `[Bug] …` topics also live in `q-a`. Local paths, device IDs and tokens were removed before
> posting. Waiting for an upstream response; no fix timeline is promised.

---

## Title

`[Bug] pluginManager.updateBundle (HMR) re-activates dsh-web-app's directory-picker-auto and fails with duplicate "directoryPicker" service`

## Body (English)

### Environment

- `@deepseek-ai/dsh` `0.2.2-rc.1` (npm-installed), Node `24.22.1`, pnpm `12.8.1`
- Fresh isolated `DSH_HOME`, web profile created with `--from-default-profile web`
  (so `dsh-base` + `dsh-web-app`; HMR enabled by default through the `hmr` row)
- Third-party bundle installed as a registry spec: `dsh-deeppilot@0.9.15`
- Target version `dsh-deeppilot@0.9.16` (published, declares `dsh.bundle`, `engines.dsh` compatible)

### Reproduction

1. Install the plugin into the profile with `dsh plugin --profile <p> add dsh-deeppilot@0.9.15`.
   The resulting `package.json` holds a registry spec and `dsh.profile.bundles` includes the name,
   so `listBundles()` marks it `updatable`.
2. The plugin's bundle patch (`cordis.patch.yml`) does the following, because a phone client cannot
   interact with a native OS picker rendered on the host:

   ```yaml
   - id: directory-picker
     disabled: true

   - insert:
       - id: deeppilot-directory-picker-browse
         name: "@deepseek-ai/dsh-host-directory-picker-browse"
       - id: deeppilot-directory-picker-browse-client
         name: "@deepseek-ai/dsh-client-ui-directory-picker-browse"
       - id: deeppilot
         name: "dsh-deeppilot"
         config: {}
   ```

3. Start `dsh <profile>`. Confirm the plugin is active and `host.listDirectory` works.
4. Trigger an update through the public service:
   `pluginManager.updateBundle('dsh-deeppilot', '0.9.16', { registry, requestId })`.
   (In our case the call is driven by a phone client over an authenticated WebSocket, but the
   failure is entirely inside the host's plugin manager.)

### Observed

`pnpm add dsh-deeppilot@0.9.16` succeeds. `installBundle` then returns:

```json
{
  "step": "install",
  "result": {
    "application": "failed",
    "stage": "enable",
    "error": {
      "code": "operation-error",
      "diagnostic": "dsh: warning: 1 entry did not activate\ndeeppilot-directory-picker-browse (@deepseek-ai/dsh-host-directory-picker-browse): Error: service \"directoryPicker\" has been registered at <NativeDirectoryPicker>"
    }
  },
  "restore": {
    "application": "failed",
    "error": { "code": "operation-error", "diagnostic": "… same duplicate-service error …" }
  }
}
```

Net effect: the target version is installed, then removed; the previous version is re-installed;
the update is reported as a failure. Reproduced twice in two independent `DSH_HOME`s (different
volumes, different `requestId`s), so it is deterministic, not an environment artifact.

### Root cause (as far as we can tell from the shipped code)

`dsh-web-app` composes the `directory-picker` row as
`@deepseek-ai/dsh-host-directory-picker-auto`. That plugin samples the host once at boot and mounts
the matching backend *and* client surface via `ctx.loader.create()` into the in-memory root tree;
its disposer removes both and awaits their fibers. On a local macOS host with a loopback bind it
chooses `native`, so `NativeDirectoryPicker` registers `ctx.directoryPicker`.

With HMR enabled, `updateBundle` performs `removeBundle(name)` → `installBundle(name@version)`.
During the intermediate composition the bundle layer is gone, so the `disabled: true` patch on
`directory-picker` disappears and `-auto` re-activates, mounting the native backend. When the
bundle layer is re-added, the inserted `-browse` row tries to register `directoryPicker` while the
native instance is still registered. Cordis rejects duplicate services, the host turns
"1 entry did not activate" into `application: 'failed'`, and the restore path hits the same
collision.

This matches the `-auto` package README ("Fixing an interaction is not a config field: compose
`-native` or `-browse` directly in place of this row … mounting the selector together with a
backend row explicitly errors, duplicate `directoryPicker` service"). The problem is that the
update's two-step replace exposes a composition state that is never reachable on a cold boot.

### Why it is not the package or the network

- `dsh plugin --profile <p> add dsh-deeppilot@0.9.16` followed by a host restart starts cleanly
  (`serverVersion 0.9.16`, all rows active, `host.listDirectory` works).
- `listVersions('dsh-deeppilot')` returns `listed` with the target compatible.
- The `check` phase of `updateBundle` passes; only the online enable step fails.

### Suggested fix

Make the remove→install transition atomic with respect to composition: do not let lower-layer rows
re-activate in the intermediate state. For example, hold the outgoing bundle's patch layer until the
incoming one is installed, then compose the final tree once and hand it to HMR; or compute the final
composition first and only apply the delta. If an online replace is inherently unsupported for
bundles that replace a service row, it would help to detect that case and return
`restart-required` instead of `failed` + rollback.

### Verified workaround

Disabling the `hmr` row in the profile's `cordis.patch.yml` makes `updateBundle` take the no-HMR
branch (install over the running version, `restart-required`). With that change:

- `host.listDirectory` keeps working (the browse backend stays mounted),
- `apply` reports `restart-required`, the profile ends up on `0.9.16`,
- after a host restart the plugin runs `0.9.16` and the durable update journal resolves to `done`.

So the whole self-update flow is functional; only the HMR online-replace path is affected.

### Evidence available on request

`plugin-manager` pnpm logs for the remove/install/restore runs, the full `updateBundle` return
object, the composed config dump (`--dump-config`), and the phone-side wire frames. Happy to attach
redacted copies.

---

## 中文说明（供维护者核对，不必随英文正文发布）

- 上游 Issues 关闭、Discussions 开启；README 第 45 行指定 bug report 走 Discussions，故标题沿用
  仓库里已有的 `[Bug]` 前缀、分类选 `Q&A`。
- 正文刻意不写本机绝对路径、设备 ID、配对凭据或令牌；证据以「可按需提供脱敏副本」表述。
- 关键取舍：不要求上游为我方插件改产品架构，只请求 `updateBundle` 的在线替换保持组合原子性；
  同时给出已验证的规避方式，避免上游误判为「第三方插件写法问题、不必修」。
- 用户确认措辞后已于 2026-11-07 提交（[#12510](https://github.com/deepseek-ai/deepseek-harness/discussions/12510)）；
  提交前已复核标题、分类与正文长度，公开内容不含本机路径、设备 ID、配对凭据或令牌。
