# Issue-style draft — HMR update fails when replacing the directory-picker backend

> Status: **draft; not posted.** Intended as a consolidated report for the existing [Discussion #12510](https://github.com/deepseek-ai/deepseek-harness/discussions/12510). The upstream repository currently has Issues disabled.
>
> Evidence: previously recorded runtime tests on DSH `0.2.2-rc.1`, plus source inspection at commit [`e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`](https://github.com/deepseek-ai/deepseek-harness/commit/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb). That commit was **not** runtime-tested in this review. Raw result files from the earlier tests are no longer available in this workspace; excerpts below are preserved in the original report and local test notes.

## Title

`[Bug] HMR update of dsh-deeppilot fails at enable with duplicate directoryPicker; restoring the previous version also reports failure`

## Summary

On a local macOS host running DSH `0.2.2-rc.1`, updating the registry-installed bundle `dsh-deeppilot` with HMR enabled reached the target's enable stage and failed with `error.code: 'operation-error'`. The diagnostic named the bundle's browse backend and a `directoryPicker` service already registered by `NativeDirectoryPicker`. The subsequent reinstallation of the previous version reported the same activation failure.

The same bundle patch worked in the recorded no-HMR and stopped-host CLI update tests. This supports a failure involving the live replacement sequence in this environment. It does not establish that every bundle containing a `disabled` override fails, or that every duplicate-service error can be resolved by restarting.

## Environment and scope

- Runtime tests: DSH `0.2.2-rc.1`, Node `24.22.1`, pnpm `12.8.1`, macOS.
- Fresh isolated `DSH_HOME`, profiles based on the default `web` composition (`dsh-base` + `dsh-web-app`), registry installation rather than `link:`.
- HMR enabled in the failing profile. The host configuration caused `directory-picker-auto`, when active, to choose the native backend. A headless, SSH or remotely bound host may choose a different backend; that environment was not covered by these tests.
- Original error-code record: `dsh-deeppilot@0.9.15` → `0.9.16`.
- Follow-up three-way comparison: `0.9.15` → `0.9.19`, the latest version **at the time of that test**.
- The published `cordis.patch.yml` is byte-identical in `0.9.15`, `0.9.16` and `0.9.19` (rechecked from npm tarballs during this review).

## Reproduction using the tested package

1. Create an isolated profile based on the default `web` template:

   ```sh
   export DSH_HOME="$(mktemp -d)"
   dsh update-repro --from-default-profile web
   ```

   Stop this initial host before step 2 and retain the same `DSH_HOME` for subsequent commands. Use unused web/bridge ports if another host is running. Keep HMR enabled and use a local macOS launch where the auto picker chooses native. The [pinned CLI example](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/cli/src/args.ts#L89-L99) confirms the profile-copy command syntax.
2. With the host stopped, install the old version into that profile:

   ```sh
   dsh plugin --profile update-repro add dsh-deeppilot@0.9.15
   ```

   Here `update-repro` is the profile created in step 1. Confirm its dependency is a registry spec and the bundle is selected.
3. Start that profile. Verify the plugin is active and directory browsing works. The bundle ships this patch; do not add another copy to the profile:

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

4. From a host-side caller with the `pluginManager` service available, await:

   ```ts
   const outcome = await ctx.pluginManager.updateBundle('dsh-deeppilot', '0.9.16')
   ```

   The caller must already inject/access that service; this is a service invocation, not a standalone script. Our recorded tests invoked it through the plugin's authenticated phone WebSocket update route. The phone transport is not part of the proposed cause.
5. Record `outcome.step`, `outcome.result` and `outcome.restore`, and inspect the final on-disk version independently of runtime activation.

The `-auto` package [documents composing a concrete backend in its place](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/host/directory-picker-auto/README.md#L38-L40). The YAML above is the actual tested implementation of that replacement, not a newly tested minimal fixture.

## Recorded error code and diagnostic

The original `0.9.15` → `0.9.16` report records these fields. This table and diagnostic are **abbreviated excerpts**, not a complete or byte-for-byte `PluginUpdateResult` dump:

| Field | Recorded value |
|---|---|
| `step` | `install` |
| `result.application` | `failed` |
| `result.stage` | `enable` |
| `result.error.code` | `operation-error` |
| `restore.application` | `failed` |
| `restore.error.code` | `operation-error` |

Both error diagnostics named the same collision. Preserved diagnostic excerpt, with line wrapping normalized:

```text
dsh: warning: 1 entry did not activate
deeppilot-directory-picker-browse (@deepseek-ai/dsh-host-directory-picker-browse):
Error: service "directoryPicker" has been registered at <NativeDirectoryPicker>
```

The recorded package installation completed successfully before enablement failed. The update advanced to `step: 'install'`, then attempted to restore the previous version. The profile returned to `0.9.15` on disk; **that does not establish that every runtime service recovered**. The restore operation still reported an activation failure.

The error-code excerpt is also present in the [original Discussion body](https://github.com/deepseek-ai/deepseek-harness/discussions/12510). We have not reconstructed missing fields or combined this excerpt with the later target version to create a purported full response.

## Recorded follow-up comparison: 0.9.15 → 0.9.19

These are prior test results, summarized in [the posted follow-up](https://github.com/deepseek-ai/deepseek-harness/discussions/12510#discussioncomment-19532694); this review did not rerun the hosts.

| Scenario | Update path | Recorded result |
|---|---|---|
| HMR enabled | `updateBundle` | Target enablement failed with duplicate `directoryPicker`; restoration reported the same failure; profile ended on `0.9.15` on disk. |
| HMR disabled | `updateBundle` | Reported `restart-required`; target `0.9.19` was installed; after restart the plugin reported `0.9.19`, the client update journal resolved to `done`, and directory listing worked. |
| Host stopped | `dsh plugin --profile update-repro add dsh-deeppilot@0.9.19` | After starting the host, the plugin reported `0.9.19`, with no recorded activation warnings, and directory listing worked. |

The journal is our plugin/client's state, not a `PluginUpdateResult` field. These successful controls cover the tested versions and configuration; they are not a guarantee for arbitrary future packages.

## Code path checked at e8f7b93a

These links describe the inspected commit, not a fresh runtime reproduction on it:

- [`updateBundle`, lines 764–799](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/boot/plugin-manager/src/index.ts#L764-L799): without HMR it installs over the running copy; with HMR it removes the installed bundle before installing the target. If installation fails or is cancelled, it reinstalls the previous version; an enable-stage failure first triggers removal of the target.
- [`installBundle`, lines 1096–1109](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/boot/plugin-manager/src/index.ts#L1096-L1109): assigns `stage: 'enable'` before selecting/reloading the bundle. [`publishAndReload` / `reload`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/boot/plugin-manager/src/index.ts#L1339-L1358) delegates to HMR reconciliation.
- [`hmr.reconcileProfile`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/boot/hmr/src/index.ts#L930-L974) calls `recomposeProfile`; [its activation check](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/boot/app-boot/src/index.ts#L415-L426) throws for introduced/required activation failures. This is an error rendered using warning-style text, not a harmless warning returned to the caller.
- [`managementError`, lines 110–114](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/boot/plugin-manager/src/index.ts#L110-L114): ordinary errors map to `operation-error` plus their diagnostic. The code is not specific to duplicate-service failures.
- Compatibility is distinct: [`checkRegistryUpdate`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/boot/plugin-manager/src/index.ts#L852-L866) can return `incompatible-version` before removal or `pnpm add` (the registry lookup itself uses pnpm). [`installBundle`](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/boot/plugin-manager/src/index.ts#L1038-L1087) also checks compatibility after the package operation, so that code is not limited to a pre-install rejection.

The measured diagnostic and this sequence support the explanation that removing the bundle temporarily drops its `disabled` override, reactivating the auto picker, and that the subsequent backend replacement collides during live reconciliation. The exact teardown/start ordering of dynamically mounted backend entries remains a lifecycle question; the final patch alone does not prove which resource remained registered at each instant.

## Expected behavior and possible directions

For a bundle that works on cold start, a desirable update outcome is either a successful live replacement or an explicitly supported installation pending restart, with the final saved version and remaining runtime state reported accurately.

Possible directions for maintainers to evaluate:

- Preserve the outgoing override until the incoming layer can replace it in one final composition, and verify disposal/start ordering for backend entries dynamically mounted by `directory-picker-auto`.
- If an update must be deferred, provide a path that retains the intended target on disk and reports `restart-required` with a defined recovery policy. Merely changing a failed result's status would not establish a healthy runtime or a valid next boot, and the current restore sequence can put the old version back on disk.
- Document this tested HMR limitation and the stopped-host workaround if no implementation change is planned.

**Correction to my earlier “cheap detector” suggestion:** `operation-error`, `stage: 'enable'` and duplicate-service text identify an activation collision. They do not establish that it is temporary, that it was caused only by the update window, or that a restart will succeed. A permanently invalid bundle can produce similar symptoms. A safe fallback needs stronger evidence than matching diagnostic strings; feasibility and implementation cost have not been established here.

## Verified workarounds for the tested case

- Stop DSH, run `dsh plugin --profile update-repro add dsh-deeppilot@0.9.19`, then start the profile again.
- Alternatively, disable the profile's `hmr` row and **restart DSH so that change takes effect** before requesting the in-app update:

  ```yaml
  - id: hmr
    disabled: true
  ```

  In the recorded test the update then used the no-HMR path and required another restart to run the target. Disabling HMR also disables profile configuration hot reload.

## Local review notes — do not publish this section

- 本稿已改回实际包名和测试版本；没有构造或验证一个名为 `X` 的最小复现包。
- `0.9.16` 的错误码摘录与 `0.9.19` 的复测矩阵分开，避免跨轮次拼接“原始 JSON”。
- 已发布的原帖与上一轮回复保留原文；本稿明确纠正其中“廉价检测”和过度泛化的部分。
- 原始运行文件当前不可用，因此不承诺提供完整日志附件；本次仅复核已存记录、线上讨论、固定提交源码及 npm 包 patch，没有新增运行验收。
- 未改变宿主兼容范围、插件行为、协议或 README；未提交或发送本稿。
