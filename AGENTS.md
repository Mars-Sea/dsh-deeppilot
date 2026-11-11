# AGENTS.md — dsh-deeppilot collaboration guide

## Repository ownership

This public repository is the only source of truth for the DSH plugin, npm
package, embedded Funnel helper, generated `lib/`, and bridge protocol.

- `PROTOCOL.md` is the normative wire contract.
- `src/protocol.ts` is the host-side TypeScript mirror.
- The private iOS repository maintains its own Swift mirror; coordinate any
  protocol change against the current version and migration policy. Protocol v2
  is the current baseline; v1 devices pair again after upgrading.

## Plugin contracts

- Export `name`, `inject`, `Config`, and `apply(ctx, options)`.
- Normalize `options`: Cordis may pass a function, object, or `undefined`.
- Send every Host RPC through `ctx.apiProxy` with an `rpcId`; read the response
  from `result`.
- mux/host stream items are `{ rpcId, payload: MuxFrame }`; unwrap `payload`
  before reading frame fields while preserving the outer request id.
- Never log pairing tokens, APNs tokens, relay credentials, or message bodies.
  Per-frame diagnostics must remain behind the `diagnostics.debug` setting
  (the settings page's switch); the old top-level `debug` field is removed and
  must not be reintroduced.
- Keep `/phone` and `/phone/health` compatible with the current iOS client.
- `tests/fixtures/*.json` are the cross-client protocol fixtures (see
  `tests/fixtures/README.md`). This repository is the only place they are
  edited; the iOS app, the relay and the Android app vendor copies and fail a
  drift test while a copy is stale. After changing a fixture, run
  `scripts/sync-protocol-fixtures.sh` in each client checkout and commit there.
- `tests/fixtures/auth-vectors.json` is the cross-language contract for the
  `c2s.auth.prove` signature input. Change the canonical string only together
  with `PROTOCOL.md`, the Swift and Kotlin mirrors, and a regenerated fixture
  (`npx tsx scripts/gen-auth-vectors.mts`, needs `swift` on macOS).

## Validation by change scope

- Documentation-only changes: check links, examples, and `git diff --check`.
- TypeScript changes: run tests, typecheck, and build; include regenerated `lib/`.
- Helper changes: run Go tests, rebuild affected binaries, verify checksums, and
  run `npm run smoke:helper`. The helper build is byte-reproducible on any host,
  so CI (on `main`) and `publish.yml` rebuild the full matrix and fail if `bin/`
  changes; merge the `chore/helper-matrix-refresh` PR before tagging a release.
  CI's `helper-smoke` job starts the committed binary on all six platforms.
  Both choices are recorded in `docs/adr/0008-funnel-helper-freshness.md`.
- Release candidates: run the full checklist below. Use `npm ci` for a clean
  dependency install or after lockfile changes; it is not needed for every edit.
- For any DSH release audit or compatibility decision, read and update
  `docs/DSH_RELEASE_MEMORY.md`; keep install, runtime, and phone-protocol risk
  classified separately.
- The DSH compatibility declaration is one rolling range, not a list of
  releases: `package.json` `engines.dsh` and all ten `@deepseek-ai/dsh*` peers
  name `>=0.2.1-rc.5 <0.3.0-0`. The lower bound is the newest audited `rc`
  release at decision time (npm `latest` and `next` both point at
  `0.2.1-rc.5`); every later `0.2.x` release activates without a per-release
  source audit, and the current `alpha` channel release `0.2.2-alpha.2` sits
  inside the same range because it sorts after the lower bound. Write
  `<0.3.0-0`, not `<0.3.0`, for the upper bound: DSH evaluates the range with
  `semver.satisfies(..., { includePrerelease: true })`, and `<0.3.0` would admit
  `0.3.0-rc.1`. The range lives in two places that must agree: `engines.dsh`,
  which DSH `0.2.1-alpha.4` and later evaluate alone, and `peerDependencies`,
  which older hosts still evaluate and npm reads at install time. DSH evaluates
  them before composing a profile on every start, not only on install, so a host
  outside the range refuses to activate the plugin. A new DSH release inside the
  range needs no declaration change; adjusting either bound is a deliberate
  policy change that needs `docs/DSH_RELEASE_MEMORY.md`,
  `tests/compatibility-metadata.test.ts`, `package-lock.json`, and both READMEs
  updated in the same change. Audit a release when it would move the lower
  bound, at each `0.x` minor boundary (the `0.3.0` gate), or when a host inside
  the range is found to break at runtime, and record the outcome in
  `docs/DSH_RELEASE_MEMORY.md`. The policy and its reversals are recorded in
  `docs/adr/0001-dsh-compatibility-policy.md`.

### Authorization and completion

Run the checks listed for a change's scope directly, without asking for
approval at each step. Fix failures caused by the change, rerun the affected
checks, and commit regenerated `lib/` before reporting done. Only the
release-only commands — `npm ci`, publishing, pushing, tagging, and GitHub
Releases — need the separate authorization described below.

### Full release checklist

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run check:config-schema
npm run smoke:helper
cd helper && go test ./...
cd ../bin && shasum -a 256 -c SHA256SUMS
cd .. && sh scripts/build-all-helpers.sh && git status --porcelain -- bin
```

The last command must print nothing: a non-empty `bin/` status means the
committed helpers were not built from the current `helper/` sources.

Commit regenerated `lib/` with source changes. Rebuild the helper and update
`bin/SHA256SUMS` whenever helper code or build inputs change.
Publishing, pushing, tagging, and creating a GitHub release require user
authorization for those actions. An explicit request to release a named version
authorizes the release steps below; reuse that authorization instead of
requesting it again at each step.

## Release process

Local release preparation and draft notes can proceed before publication is
authorized. Execute the external release steps once the user authorizes that
version, respecting any stated exclusions or manual testing gates. The
release version in `package.json`, the root entries in `package-lock.json`, the
release commit, npm package, Git tag, and GitHub Release must all agree.

1. Update both manifests **and `tests/apply-baseline.snapshot.json`** — regenerate
   that snapshot with `RECORD=1 npx tsx --test tests/apply-baseline.test.ts` and
   confirm its diff holds nothing but the `version` fields, because it carries
   `serverVersion`/`pluginVersion` and `npm test` fails without it — then
   regenerate `lib/`, run every required check, inspect
   `npm pack --dry-run --json`, and isolate the intended release changes
   from unrelated worktree edits before committing.
2. Commit the release, push it, wait for CI, then create and push the matching
   annotated `vX.Y.Z` tag from that exact commit.
3. Prepare the GitHub Release as a draft from `docs/RELEASE_NOTES-X.Y.Z.md`
   (its first line is the title, the rest is the body):
   - Title: `DeepPilot X.Y.Z` only, with no tagline.
   - Body: `## 中文` first, then `## English`, with the same items in both.
   - One bullet per user-visible change: a bold lead-in and one sentence, at
     most about seven bullets, compatibility last. Keep at most one key number
     per item; protocol fields, capability bits and test counts belong in
     `PROTOCOL.md` and the evidence docs, not here.
   - Do not hard-wrap: each bullet is one line, because GitHub release pages
     render every newline as a line break.
4. 获授权后，在匹配的版本标签上手动运行 `.github/workflows/publish.yml`，
   通过 OIDC 身份认证完成 npm 可信发布并生成来源证明（Provenance）。
   稳定版使用 `latest`（稳定分发标签），预发布版使用 `alpha`（预发布分发标签）；
   npm 绑定与操作步骤见 `docs/NPM_PUBLISHING.md`，决策见 `docs/adr/0003-release-and-repo-visibility.md` 第 2 条。
   不在 `main` 上运行后另行检出标签，以免来源证明的提交与实际源码不同。
   若用户保留自行发布，提供该文档中的已核对手动命令。
   绑定已勾选 `Allow npm publish`（2026-11-05 起），工作流直接公开版本并写入分发标签，
   无需维护者批准。
5. 工作流末尾核对注册表版本、分发标签、包完整性与来源证明；通过后在干净隔离的
   `DSH_HOME` 中完成一次从 npm 的安装验证。若核对 404 且发布步骤提示进入 staged 区，
   说明绑定退回了暂存模式，按 `docs/NPM_PUBLISHING.md` 处理。
6. Publish the prepared GitHub Release only after npm is installable, so the
   in-app update link never leads users to an unavailable package version.

## Agent skills

### Issue tracker

Issue 放在本仓库的 GitHub Issues（公开），用 `gh` CLI 操作。See `docs/agents/issue-tracker.md`.

### Domain docs

single-context（单上下文）：根目录 `GLOSSARY.md` + `docs/adr/`（被 gitignore，仅本地）。See `docs/agents/domain.md`.
