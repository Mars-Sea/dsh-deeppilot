# AGENTS.md — dsh-deeppilot collaboration guide

## Repository ownership

This public repository is the only source of truth for the DSH plugin, npm
package, embedded Funnel helper, generated `lib/`, and bridge protocol.

- `PROTOCOL.md` is the normative wire contract.
- `src/protocol.ts` is the host-side TypeScript mirror.
- The private iOS repository maintains its own Swift mirror; coordinate any
  protocol change explicitly and preserve protocol-v1 compatibility.

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

## Required checks

```sh
npm ci
npm test
npm run typecheck
npm run build
cd helper && go test ./...
cd ../bin && shasum -a 256 -c SHA256SUMS
```

Commit regenerated `lib/` with source changes. Rebuild the helper and update
`bin/SHA256SUMS` whenever `helper/` changes. Never publish npm, push, tag, or
create a GitHub release without explicit approval.

## Release process

Only begin a release after the user explicitly approves that version. The
release version in `package.json`, the root entries in `package-lock.json`, the
release commit, npm package, Git tag, and GitHub Release must all agree.

1. Update both manifests, regenerate `lib/`, run every required check, inspect
   `npm pack --dry-run --json`, and confirm the worktree contains only the
   intended release changes.
2. Commit the release, push it, wait for CI, then create and push the matching
   annotated `vX.Y.Z` tag from that exact commit.
3. Prepare the GitHub Release as a draft. Its notes must contain an English
   section and a Simplified Chinese section describing the same changes.
4. Stop and ask the user to run `npm publish`; never execute npm publication on
   the user's behalf.
5. Verify the registry version, dist-tag, package metadata, and a clean DSH
   profile install. Publish the prepared GitHub Release only after npm is
   installable, so the in-app update link never leads users to an unavailable
   package version.
