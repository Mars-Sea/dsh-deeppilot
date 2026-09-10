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
  Per-frame diagnostics must remain behind the `debug` setting.
- Keep `/phone` and `/phone/health` compatible with the current iOS client.

## Validation by change scope

- Documentation-only changes: check links, examples, and `git diff --check`.
- TypeScript changes: run tests, typecheck, and build; include regenerated `lib/`.
- Helper changes: run Go tests, rebuild affected binaries, and verify checksums.
- Release candidates: run the full checklist below. Use `npm ci` for a clean
  dependency install or after lockfile changes; it is not needed for every edit.

### Full release checklist

```sh
npm ci
npm test
npm run typecheck
npm run build
cd helper && go test ./...
cd ../bin && shasum -a 256 -c SHA256SUMS
```

Commit regenerated `lib/` with source changes. Rebuild the helper and update
`bin/SHA256SUMS` whenever helper code or build inputs change.
Publishing, pushing, tagging, and creating a GitHub release require user authorization for those actions. An
explicit request to release a named version authorizes the release steps below;
reuse that authorization instead of requesting it again at each step.

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
