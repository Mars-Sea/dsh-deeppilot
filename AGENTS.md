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
- Helper changes: run Go tests, rebuild affected binaries, and verify checksums.
- Release candidates: run the full checklist below. Use `npm ci` for a clean
  dependency install or after lockfile changes; it is not needed for every edit.
- For any DSH release audit or compatibility decision, read and update
  `docs/DSH_RELEASE_MEMORY.md`; keep install, runtime, and phone-protocol risk
  classified separately.
- The DSH peer range (`package.json` `peerDependencies`) names exactly the two
  releases this branch supports: `0.2.0-rc.2` (the npm `latest`/`next` channels)
  and `0.2.1-alpha.3` (the `alpha` channel). DSH evaluates that range before
  composing a profile on every start, not only on install, so any other host
  version refuses to activate the plugin. Widening the list is therefore part of
  shipping support for a new DSH release: source-diff it, record it in
  `docs/DSH_RELEASE_MEMORY.md`, then add the version here, in
  `tests/compatibility-metadata.test.ts`, in `package-lock.json`, and in both
  READMEs. The policy and the reversal it represents are recorded in
  `docs/决策记录.md` (章节一).

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
cd helper && go test ./...
cd ../bin && shasum -a 256 -c SHA256SUMS
```

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

1. Update both manifests, regenerate `lib/`, run every required check, inspect
   `npm pack --dry-run --json`, and isolate the intended release changes
   from unrelated worktree edits before committing.
2. Commit the release, push it, wait for CI, then create and push the matching
   annotated `vX.Y.Z` tag from that exact commit.
3. Prepare the GitHub Release as a draft. Its notes must contain an English
   section and a Simplified Chinese section describing the same changes.
4. Run `npm publish` when authorized. If the user has reserved publication for
   themselves, provide the verified package and command for that manual step.
5. Verify the registry version, dist-tag, package metadata, and a clean DSH
   profile install. Publish the prepared GitHub Release only after npm is
   installable, so the in-app update link never leads users to an unavailable
   package version.
