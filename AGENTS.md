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
- `tests/fixtures/auth-vectors.json` is the cross-language contract for the
  `c2s.auth.prove` signature input. The iOS `AuthVectorTests` read it in place
  from the sibling checkout. Change the canonical string only together with
  `PROTOCOL.md`, the Swift mirror, and a regenerated fixture
  (`npx tsx scripts/gen-auth-vectors.mts`, needs `swift` on macOS).

## Validation by change scope

- Documentation-only changes: check links, examples, and `git diff --check`.
- TypeScript changes: run tests, typecheck, and build; include regenerated `lib/`.
- Helper changes: run Go tests, rebuild affected binaries, verify checksums, and
  run `npm run smoke:helper`. The helper build is byte-reproducible on any host,
  so CI (on `main`) and `publish.yml` rebuild the full matrix and fail if `bin/`
  changes; merge the `chore/helper-matrix-refresh` PR before tagging a release.
  CI's `helper-smoke` job starts the committed binary on all six platforms.
  Both choices are recorded in `docs/决策记录.md` (章节八).
- Release candidates: run the full checklist below. Use `npm ci` for a clean
  dependency install or after lockfile changes; it is not needed for every edit.
- For any DSH release audit or compatibility decision, read and update
  `docs/DSH_RELEASE_MEMORY.md`; keep install, runtime, and phone-protocol risk
  classified separately.
- The DSH compatibility declaration names exactly the five releases this branch
  supports: `0.2.0-rc.2` (the npm `latest` channel), the `alpha` channel releases
  `0.2.1-alpha.3`, `0.2.1-alpha.4`, and `0.2.1-alpha.5`, and `0.2.1-rc.2` (the
  npm `next` channel). It lives
  in two places that must agree: `package.json` `engines.dsh`, which DSH
  `0.2.1-alpha.4` and later evaluate alone, and `package.json`
  `peerDependencies`, which older hosts still evaluate and npm reads at install
  time. DSH evaluates them before composing a profile on every start, not only on
  install, so any other host version refuses to activate the plugin. Widening the
  list is therefore part of shipping support for a new DSH release: source-diff
  it, record it in `docs/DSH_RELEASE_MEMORY.md`, then add the version in both
  declarations, in `tests/compatibility-metadata.test.ts`, in
  `package-lock.json`, and in both READMEs. The policy and the reversal it
  represents are recorded in `docs/决策记录.md` (章节一).

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
3. Prepare the GitHub Release as a draft. Its notes must contain an English
   section and a Simplified Chinese section describing the same changes.
4. 获授权后，在匹配的版本标签上手动运行 `.github/workflows/publish.yml`，
   通过 OIDC 身份认证完成 npm 可信发布并生成来源证明（Provenance）。
   稳定版使用 `latest`（稳定分发标签），预发布版使用 `alpha`（预发布分发标签）；
   npm 绑定与操作步骤见 `docs/NPM_PUBLISHING.md`，决策见 `docs/决策记录.md` 三之2。
   不在 `main` 上运行后另行检出标签，以免来源证明的提交与实际源码不同。
   若用户保留自行发布，提供该文档中的已核对手动命令。
5. Verify the registry version, dist-tag, package metadata, and a clean DSH
   profile install. Publish the prepared GitHub Release only after npm is
   installable, so the in-app update link never leads users to an unavailable
   package version.
