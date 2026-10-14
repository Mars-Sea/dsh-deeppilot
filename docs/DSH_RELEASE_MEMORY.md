# DSH release compatibility memory

> This is the durable audit record for DeepPilot's public DSH plugin. Re-audit
> the next DSH release instead of assuming that an rc upgrade is runtime-safe.

## Current decision

- **Audited release:** `dsh-v0.2.1-alpha.3` (official release page:
  <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.3>),
  published to npm 2026-10-14T13:32:15Z on the `alpha` dist-tag. It is **not**
  `latest`; `latest`/`next` still point at `0.2.0-rc.2`. Baseline commit
  `2fbf4359b82fb94c03dcce0b831660d87f12ea5c`, compared against alpha.2's
  `d743267388641bc76f17c45ce8b4c231aed1d32c` (**852 commits, 3311 changed files,
  120,978 insertions, 16,632 deletions**).
- **Comparison baseline:** `dsh-v0.2.1-alpha.2` (the previous audited tag).
- **Plugin runtime verdict: four confirmed breaks with one root cause — the
  alpha.3 Peer model — and the resident interaction client does not start.**
  **Fixed in this audit; see "The fix" below.**
  This release makes every in-process carrier name a `PeerScope`
  (`principal` / `signal` / `interactions`) explicitly; nothing defaults to the
  operator any more. The four landing points, each with its own evidence:

  | # | Upstream change | Plugin seam | Evidence |
  | --- | --- | --- | --- |
  | 1 | `TypertGatewayWireStream.open`'s 4th parameter `peer` is required; `assertPeerLive()` reads `peer.signal.aborted` before anything else | `src/dsh-remote-interactions.ts:180` passes `undefined, undefined` | Reproduced against the published bundles: alpha.2 returns normally, alpha.3 throws `TypeError: Cannot read properties of undefined (reading 'signal')` |
  | 2 | `$events` additionally requires `peer.interactions === 'answer'` (`requireInteractions`) | same call | Reproduced: a peer with `interactions: 'none'` gets `gateway/interactions-forbidden`; a full owner/answer peer passes on **both** versions |
  | 3 | `ConnectionFetchHandler.fetch(request, peer)` now takes a required Peer | `src/dsh-remote-interactions.ts:204` calls `fetchHandler.fetch(request)` | `lib/types/rpc.d.ts` declares `peer: PeerScope` required, "never defaulted" |
  | 4 | `./client` gained `node`/`browser` conditions; Node now resolves `lib/client.node.js`, which carries **no** `window.__ModuleLoader__.load` banner | `loadClientFaces()` (`src/dsh-remote-interactions.ts:117`) builds its module table from that banner | `grep -c __ModuleLoader__` is 0 in `client.node.js`, 1 in `client.browser.js` and 1 in alpha.2's `client.js` |

  A fifth, latent one: `installConnection` derives
  `interactions ?? (location === undefined ? 'none' : 'answer')`, and the
  plugin's Node context has no `location`, so `apply(ctx)` alone always selects
  `'none'`. Passing an explicit Peer is not enough by itself — the install call
  must name `interactions: 'answer'` too.
- **Failure mode is degradation, not a crash — but only partly contained.**
  `src/dsh-api-proxy.ts:316` wraps `startDshRemoteInteractions` in `try/catch`
  and logs `[deeppilot] DSH Remote interaction client unavailable`. Breaks 3 and
  4 surface while the resident client is being assembled, so they land in that
  catch. Whether break 1/2 (the Gateway opens its Remote Events generation
  asynchronously) also lands there is **not confirmed** — an uncaught rejection
  there would be fatal under Node's default `--unhandled-rejections=throw`.
  The phone loses approval/question delivery either way.
- **Fix direction (verified compatible with both hosted versions):** build one
  owner/answer Peer (`new Peer(ownerCtx, { principal: { kind: 'owner' },
  interactions: 'answer' })`, falling back to `connection.operator` on alpha.2)
  and name it in every carrier call — alpha.2 ignores a second `fetch` argument
  and defaults an absent `open` peer to the operator, so one call form serves
  both. `loadClientFaces` additionally has to accept the Node bundle's named
  exports when the banner did not fire; both shapes export `apply`/`inject`
  (`installConnection`/`transportError` are extra on Node).
- **Install verdict: the peer range now names this release explicitly.** It moved
  from the open-ended `>=0.2.0-rc.2 <0.3.0-0` to `0.2.0-rc.2 || 0.2.1-alpha.3`
  across all ten `@deepseek-ai/dsh*` peers, and the two vendor peers widened to
  `~4.0.4 || ~4.0.5-alpha.1` and `~3.18.4 || ~3.18.5-alpha.1`. Because DSH
  evaluates that range on every start, the next DSH release deactivates this
  plugin until the list is widened deliberately — see `docs/决策记录.md`
  (章节一, 条目2), which records this as a reversal of the 2026-09-29 policy.
  The published CLI composed the plugin's patch cleanly before the change (see
  the 2026-10-14 entry). The plugin's own `lib/client.js` shape was not
  re-verified against the alpha.3 client-modules scanner.
- **Protocol verdict: no phone-protocol change.** Protocol v2, pairing state,
  and device records are untouched by this release; no phone needs to re-pair.
- **Two host-side migrations this machine must apply** (independent of the
  plugin): `~/.dsh/profiles/web/cordis.patch.yml` carries
  `llm-deepseek-account.config.models: []`, and alpha.3 throws on any residual
  `models` key — **including an empty array** (`resolveAccountOptions`). Also
  `dsh --profile <name> --from-default-profile <template>` now *replaces* an
  existing profile directory (it deletes the old `node_modules` and
  `cordis.patch.yml`); the audit procedure recorded below used that flag.
- **Capability gaps, not regressions:** the `contextBreakdown` projection was
  reshaped (`nodes[]` → `systems[]` + `surfaceTokens` + `claim`, stateVersion
  5→6) and the plugin forwards it by key, so the phone may render empty values;
  the model catalog shrank (account routes return only the version-gated
  `offered` subset, pi-ai routes without a resolvable key return `[]`); and
  `CLIENT_UPGRADE_REQUIRED` / `MODEL_UNSUPPORTED` are new codes with no mapping
  in `src/wire-errors.ts` yet.

### Previous decision — `dsh-v0.2.1-alpha.2`

- **Audited release:** `dsh-v0.2.1-alpha.2` (official release page:
  <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.2>),
  published to npm 2026-10-09T08:18:00Z on the `alpha` dist-tag. It is **not**
  `latest`; `latest`/`next` still point at `0.2.0-rc.2`.
- **Comparison baseline:** `dsh-v0.2.1-alpha.1` (the previous audited tag).
- **Plugin runtime verdict: one confirmed break, fixed in this audit.**
  `SessionController.projections` now requires its cancellation signal — the
  published implementation calls `signal.throwIfAborted()` as the first
  statement of its `try` and reads `signal.aborted` in its `catch`, while the
  adapter called it with no signal at all, so every projection baseline read
  failed with a `TypeError` instead of returning values. The adapter now passes
  a signal and its hand-written mirror declares `signal` required. See "The one
  confirmed break" in the 2026-10-09 entry for the reproduction, the fix, and
  the regression test that pins it.
- **What is unaffected:** `list`, `inspect(sessionId)` (its signal is still
  optional upstream), `create`, `fork`, `rename`, `cancel`, `attachment`,
  `prompt`, `selectModel`, `modelCatalog`, the workspace controller, the Gateway
  wire-stream seam the resident approval/question client depends on, the shared
  Fetch carrier, and every peer package's exported runtime surface.
- **Install verdict:** the peer range `>=0.2.0-rc.2 <0.3.0-0` admits
  `0.2.1-alpha.2` under `semver.satisfies(..., { includePrerelease: true })`,
  which is how DSH's `evaluatePluginCompatibility` gates activation; npm's
  **default** prerelease handling still reports peer warnings for
  `@deepseek-ai/dsh`, `cordis`, and `schemastery`. Composing a real Web profile
  with this plugin's `cordis.patch.yml` on the published CLI adds the plugin's
  three rows plus its own config schema and no plugin-attributed diagnostic; the
  four base-profile schema errors it prints reproduce identically without the
  patch.
- **Protocol verdict:** no required DeepPilot phone-protocol break. Protocol v2,
  pairing state, and device records are unchanged; already-paired phones need no
  action.
- **Capability gaps, not regressions:** the new `workingDirectory` projection,
  the new `formatStatus` list field, the `mode: 'external'` subagent catalog, and
  the `session/migration-required` fork refusal are all things this plugin does
  not consume, and none of them change a call it already makes.

### Plugin release verdicts

- **Release candidate (`0.9.5`, 2026-10-15):** carries the alpha.3 Peer/client
  compatibility repair, the exact two-host peer policy, cross-language auth
  vectors and recovery guidance, and the manual OIDC/provenance workflow.
  The package and both lockfile version entries are `0.9.5`; the apply baseline
  records that version. Clean install, 562 passing unit tests (zero failures,
  one existing TODO), typecheck, build, the real pinned-host schema loader,
  Go tests, all six helper checksums, and package inspection pass locally.
  The altered-challenge test now mutates the challenge from its own socket,
  eliminating the timestamp collision, and passes 20 consecutive focused runs.
  Registry/provenance and clean published-profile checks remain release gates;
  no physical-iPhone validation is claimed. Notes: `docs/RELEASE_NOTES-0.9.5.md`.

- **Release verdict (`0.9.4`, published 2026-10-10, tag `v0.9.4` @ `e2f77af`):**
  carries the `projections` adapter fix and the Automation tasks documentation
  correction described in the 2026-10-09 entry below. `package.json`, both root
  `package-lock.json` version entries, and `tests/apply-baseline.snapshot.json`
  are on `0.9.4`, and `lib/` is regenerated. The full checklist passed locally:
  `npm ci`, 538 unit tests, typecheck, build, the config-schema check against a
  real `0.2.0-rc.2` CLI, Go helper tests, helper checksums, and
  `npm pack --dry-run` (65 files, 50,916,470 bytes packed). The fix was also
  verified on a live `0.2.1-alpha.2` host against the published `0.9.3` as an
  A/B control (25 pass / 0 fail either way, with the `sessions.projections
  failed: internal` diagnostic present only on `0.9.3`).
  - **Registry verification after publishing.** `dist-tags.latest` moved off
    `0.9.3`; `dist.shasum` `85b3c71a802e45e42f5fb1b23444ed2e396d39dc` is
    byte-identical to the local `npm pack` output at the tag; 65 files,
    `dist.unpackedSize` 130,789,604. **`gitHead` is `e2f77af`, the tag commit** —
    the 0.9.3 ordering deviation did not repeat, because the release notes and
    every other documentation change were committed before the pack. The publish
    itself needed the maintainer's one-time password, as in 0.9.3; everything up
    to and after it was done here.
  - **Clean-profile verification.** A fresh isolated home, built from the shipped
    Web template and installed with the published `0.2.1-alpha.2` CLI
    (`dsh plugin --profile verify add dsh-deeppilot@0.9.4`), composed a real
    profile: `--dump-config` printed the plugin's three rows
    (`deeppilot-directory-picker-browse`, `…-browse-client`, `deeppilot`) with no
    missing-module or load error, the installed package's six helper checksums
    verified, every helper binary embedded `go1.26.9`, and the installed
    `lib/index.js` carried the projections fix. Only then was the GitHub Release
    taken out of draft and marked Latest.
  - **The release also had to fix the helper's toolchain and its refresh
    workflow.** CI's `govulncheck` job reported 11 reachable Go standard-library
    vulnerabilities for the pinned `go 1.26.6`; this is time-triggered, not
    caused by the release — `0.9.3`'s CI was green on 2026-10-05 with the same
    helper source. `helper/go.mod` now pins `go 1.26.9`, and the six `bin/`
    binaries were rebuilt with it. That rebuild only became correct after fixing
    `.github/workflows/build-helpers.yml`: each build job uploaded the whole
    `bin/` tree, so every artifact also carried the checked-out copies of the
    targets its runner never rebuilt, and `merge-multiple` let those stale files
    overwrite the fresh ones (the first refresh PR mixed two toolchains — only
    darwin-arm64 embedded `go1.26.9`). The workflow now uploads only the
    per-matrix target globs; PR #19 then carried all six at `go1.26.9` and was
    merged as `f0f243b`.
  - **Checklist environment notes for the next release.**
    (a) `~/.npm/_cacache` contains root-owned files on this machine, so `npm view`
    and `npm pack` fail with `EPERM` unless `npm_config_cache` points at a
    writable cache — the run above used the workspace audit cache.
    (b) Go's default build cache lives outside the workspace and the file sandbox
    blocks it (`open .../Library/Caches/go-build/...: operation not permitted`,
    reported as `[setup failed]`); point `GOCACHE` at a workspace directory.
    (c) `gh` writes its run-log cache under `~/.cache/gh` and fails the same way;
    point `XDG_CACHE_HOME` at a workspace directory.
    None of the three is a repository defect.
- **Release verdict (`0.9.3`, published 2026-10-05, tag `v0.9.3` @ `b85869b`):**
  shipped to `latest`. Verified on the registry: version present, `dist-tags.latest`
  moved off `0.9.2`, 65 files, `dist.shasum` `90f0c665c395a7043eb3689a291cf28c88bc39ab`
  byte-identical to the locally verified `npm pack` output, and a clean install plus
  a real `dsh --profile web --dump-config` compose (188 entries) with the plugin's
  three `cordis.patch.yml` entries present and no missing-module error. Ships
  issue #24 (`100.64.0.0/10` becomes a selectable pairing target) and the Windows
  journal `fsync` tolerance fix. Protocol v2 unchanged; paired phones need no action.
  - **`gitHead` deviation, recorded rather than hidden.** The registry records
    `gitHead` `fbda6a5`, the docs-only commit that added `RELEASE_NOTES-0.9.3.md`,
    while tag `v0.9.3` points at `b85869b`. The cause is ordering, not content:
    the tarball was packed before that docs commit, and npm stamps `gitHead`
    from HEAD at publish time. The shipped bytes are provably `b85869b`'s tree —
    the published `dist.shasum` equals the local `npm pack` output and the tarball
    does not contain `RELEASE_NOTES-0.9.3.md`. `fbda6a5` is `b85869b`'s child and
    changes no packaged file. Versions are immutable on npm, so this cannot be
    corrected retroactively; **do it differently next time: commit every doc file
    before packing, and pack after the last commit.** The 0.9.2 entry below had
    `gitHead` matching the tag because no commit landed between pack and publish.
  - **Install caveat users will hit — DSH's release-age policy.** Confirmed again
    while verifying this release: `dsh plugin add --profile web` writes a
    `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml` and an explicit
    `dsh-deeppilot@0.9.3` installs the new version. Expect the unversioned form to
    resolve to a slightly older release for a while; this is expected DSH
    behaviour, not a publishing failure.
- **Release verdict (`0.9.2`, published 2026-10-05, tag `v0.9.2` @ `4b43671`):**
  shipped to `latest`. Verified on the registry: version present, `dist-tags.latest`
  moved off `0.9.1`, `gitHead` `4b436715` matches the tag and HEAD, 65 files,
  and a clean DSH profile install of `dsh-deeppilot@0.9.2` composes with the
  plugin's three `cordis.patch.yml` entries present and no missing-module error.
  `scripts/smoke-live.mts` passed with **0 failures** against a live
  **`dsh-v0.2.1-alpha.1`** web profile — the first live-host verification since
  the 0.9.1 entry, retiring the gate it left open ("pending separate
  authorization before the `0.9.1` release ships"), on a newer host than the
  rc.2 that entry contemplated, which is strictly stronger evidence: the
  `0.2.1-alpha.1` source-diff above found zero changed `src/` files across all
  12 peer packages, and the live run agrees. The plugin's own build and type
  baselines stay pinned to `0.2.0-rc.2`; nothing about the pin changed.
  - **Install caveat users will hit — DSH's release-age policy.** On a clean
    profile, `dsh plugin add dsh-deeppilot` installed **`0.9.1`**, not the just
    published `0.9.2`, even though `latest` already pointed at `0.9.2`. DSH
    deliberately prefers a slightly older release and offers an exact-version
    path instead; `dsh plugin add dsh-deeppilot@0.9.2` installs the new one.
    This is expected DSH behaviour, not a publishing failure — do not read the
    older version in the installer as a broken release.
  - **Peer-range note for future audits.** `evaluatePluginCompatibility` checks
    each peer against the *running DSH version*, but `cordis` and `schemastery`
    are host-vendored third parties and `react` comes from the Web app. Judging
    those three against a DSH version number reports false mismatches. They are
    also `optional` in `peerDependenciesMeta`. Confirm installability by
    composing a real profile, not by iterating the peer table.
- **Two tracked follow-ups:**
  1. ~~Projection signal.~~ **Resolved 2026-10-10:** the adapter passes
     `new AbortController().signal` to `session.projections` and the mirror
     declares `signal` required, so the compiler enforces it. Covered by a new
     regression test that fails against the previous call form. 538 unit tests,
     typecheck, and build pass with regenerated `lib/`.
  2. **Automation tasks documentation: public docs fixed, iOS copy open.**
     Automation was a short-lived optional bundle: DSH 0.2.0 moved it out of the
     shipped Web composition, and the following release retired
     `@deepseek-ai/dsh-experimental-schedule-bundle` again — `dsh-web-app` now
     mounts `schedule` and `ui-schedule` in every Web profile. `COMPATIBILITY.md`,
     `PROTOCOL.md`, `docs/DEEPPILOT_FEATURE_PLAN.md`, and the schedule-service
     comment in `src/dsh-api-proxy.ts` now state that; the private app still
     ships `error.scheduleUnsupported` and `schedule.unsupported` copy telling
     the user to enable it (`app-private/ios/L10nFragments/schedule.json` and the
     generated `zh-Hans.lproj` / `en.lproj` string tables). **iOS copy still
     open** — it belongs to the private repository and to its own release flow.
  3. ~~`subagent_session` is unmapped.~~ **Resolved 2026-10-03:** mapped to
     `E_PROTOCOL` in `src/wire-errors.ts` and added to the frozen expectation in
     `tests/wire-errors.test.ts`. 525 unit tests, typecheck, and build pass.

### Previous decision — `dsh-v0.2.1-alpha.1`

- **Audited release:** `dsh-v0.2.1-alpha.1`, published 2026-10-03 (npm
  `alpha` dist-tag, also not `latest`). Comparison baseline was
  `dsh-v0.2.0-rc.2`.
- **Plugin runtime verdict:** no breaking change in the DSH APIs DeepPilot calls.
  All 12 peer packages had **zero** changed `src/` files; each changed only its
  `package.json` version field and its READMEs. Full table in the 2026-10-03
  entry below.
- **Nothing was changed to support that release.** `package.json`,
  `package-lock.json`, generated `lib/`, `COMPATIBILITY.md`, and `PROTOCOL.md`
  stayed on the `0.2.0-rc.2` baseline — no version bump, no dependency install,
  no `lib/` regeneration. The same held for its source diff; the alpha.2 audit
  that followed then produced one adapter fix (see the 2026-10-09 entry).
- **Peer range:** `>=0.2.0-rc.2 <0.3.0-0` admitted `0.2.1-alpha.1` through
  `semver.satisfies(..., { includePrerelease: true })`; the `~4.0.4` / `~3.18.4`
  vendor ranges admitted `4.0.5-alpha.1` / `3.18.5-alpha.1` the same way, and
  npm's default prerelease rules reported warnings for those three.
- **Protocol verdict:** no required phone-protocol break; protocol v2, pairing
  state, and device records unchanged.

### Previous decision — `dsh-v0.2.0-rc.2`

- **Audited release:** `dsh-v0.2.0-rc.2` (official release page:
  <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2>).
- **Comparison baseline:** `dsh-v0.2.0-rc.1` (the previous plugin baseline).
- **Plugin runtime verdict:** **no breaking change in the DSH APIs that DeepPilot
  currently calls.** 9 of the 10 peer packages are source-identical to rc.1;
  see the 2026-09-29 rc.2 entry below for the full finding-by-finding table.
- **Peer range policy change:** the DSH peer range in `package.json` moved from
  an exact pin (`0.2.0-rc.1`) to `>=0.2.0-rc.2 <0.3.0-0`. This is a deliberate
  product decision, not just a version bump: every future `0.2.x` host —
  further release candidates and the eventual `0.2.0` GA — now installs the
  plugin without a `package.json` edit, trusting the audit history on this
  page instead of gating installability on it. The re-audit obligation below
  is unchanged: still source-diff and record every new DSH release; a `0.3.x`
  line still requires its own audit and its own range widening before it
  installs. Recorded in `docs/决策记录.md` (章节一, 条目1).
- **Install/deployment verdict:** the peer range, the compatibility assertions,
  the registry lockfile, and generated `lib/` are updated for rc.2. `npm ci`,
  unit tests (304 passing), typecheck, build, the config-schema check against a
  real `0.2.0-rc.2` CLI, Go helper tests, and helper checksums all pass locally
  against the new range. The one remaining release-only step is a live
  `scripts/smoke-live.mts` run on a real rc.2 host, pending separate
  authorization before the `0.9.1` release ships.
  **Closed 2026-10-04:** that gate was discharged by the `0.9.2` live run
  instead — see the release verdict in "Current decision" above. It ran on
  `0.2.1-alpha.1` rather than rc.2, which supersedes this entry's intent.
- **Protocol verdict:** no required DeepPilot phone-protocol break. Protocol v2,
  pairing state, and device records are unchanged; already-paired phones need no
  action.
- **One behavioural change carried over from rc.1:** DSH 0.2.0 moved automation
  out of the shipped Web composition. See "Automation is now an optional
  bundle" below. The plugin needs no code change; the phone's copy now points
  at the bundle.

## 2026-10-14 — audit of `dsh-v0.2.1-alpha.3`

### Scope and method

Compared `dsh-v0.2.1-alpha.2...dsh-v0.2.1-alpha.3` (**852 commits, 3311 changed
files, 120,978 insertions, 16,632 deletions**) by fetching the new tag into the
existing blobless clone (`.audit-dsh-alpha2`, whose HEAD was already the alpha.2
audit's target SHA `d7432673`), then `git diff --name-status` and per-path
content diffs into `.audit-alpha3/diffs/`. Four parallel read-only passes
covered `packages/api` + `apps/cli` + `packages/typert` + `packages/settings` +
`vendor`, `packages/client/{connection,locale,ui-settings,ui-slots}` +
`packages/boot` + `packages/bundle`, `packages/{credentials,subagent,session,
schedule}`, and `packages/{core,host,skill,llm}`. All **14** upgrade guides
added by this release (under `docs/upgrade-guide/v0.2.0-rc.2/`,
`v0.2.1-alpha.1/`, `v0.2.1-alpha.2/`) were read in Chinese in full.

The alpha.2 audit's lesson — judge the seams reached through `ctx.get`, not just
the peer list — is what caught this one: the peer list is *not* where the breaks
are. `@deepseek-ai/dsh-api-remote-access` is new, `packages/schedule/schedule`
has **zero** changed source files, and the peer packages' own exported surfaces
moved far less than the carrier contracts around them.

### The four confirmed breaks

Every one is the same root cause: alpha.3 makes the Peer explicit. `PeerScope`
(`@deepseek-ai/dsh-typert-protocol`) gained required `principal`, `signal`, and
`interactions`; `client/connection` added a `Peer` class and deleted
`OperatorPeer`; the Gateway deleted `operatorPeer()` and its
`request.peer ?? this.operatorPeer()` fallback.

Reproduction used the **published** bundles, the same technique as the alpha.2
`projections` break, with the plugin's exact argument list
(`open('$events', payload, undefined, peer, signal)`):

```sh
# .audit-alpha3/repro-peer-contract.mjs, against
#   alpha.2: ~/.npm/_npx/b5c6312874079fe8/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js
#   alpha.3: .audit-alpha3/cli-install/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js
# A. peer = undefined                       (what the plugin sends today)
alpha.2: 未抛错
alpha.3: 抛错 TypeError: Cannot read properties of undefined (reading 'signal')
# B. peer = { principal: owner, signal, interactions: 'none' }
alpha.2: 未抛错
alpha.3: 抛错 TypertGatewayError: $events: forwarded Remote events require interactions=answer
# C. peer = { principal: owner, signal, interactions: 'answer' }
alpha.2: 未抛错
alpha.3: 未抛错
```

Break 4 was settled by reading the shipped artifacts rather than by inference:
`@deepseek-ai/dsh-client-connection`'s `./client` now maps `node` →
`lib/client.node.js`, and that file contains **zero** `__ModuleLoader__`
occurrences while `client.browser.js` and alpha.2's `client.js` each contain
one. `loadClientFaces` builds its module table *only* from that banner, so on
Node the table stays empty. Both shapes export `apply` and `inject`, which is
what makes a banner-optional fallback possible.

### The fix

One call form serves both audited hosts, because alpha.2 ignores a second
`fetch` argument and defaults an absent `open` peer to the operator Peer it
holds:

- `src/dsh-remote-interactions.ts` mints one Peer through
  `connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })`
  and falls back to `connection.operator` on a Host without that entry point.
  The same Peer is named on `fetch` and on `wireStream.open`.
- The Connection install prefers the explicit
  `installConnection(ctx, { transport, interactions: 'answer' })`, because
  `apply(ctx)` cannot name the participation and therefore always selects
  `'none'` for this caller; `apply` remains the fallback for a host that predates
  the installer.
- `loadClientFaces` accepts a Node bundle's named exports when the browser
  banner did not register them. A banner registration still wins, because the
  bundle's own internal `require()` resolves against it.

Six regression tests in `tests/dsh-wire-stream-contract.test.ts` pin the
contract: the operator fallback, the alpha.3 `createPeer` request shape and the
Peer reaching `wireStream.open`, both installer branches, and both module-table
branches. The file fails against the previous call form — verified by restoring
the source and re-running (1 failure) — and passes after the fix.

### Peer range narrowed to the two audited hosts

By explicit user direction the DSH peer range stopped being open-ended:
`>=0.2.0-rc.2 <0.3.0-0` became `0.2.0-rc.2 || 0.2.1-alpha.3` across all ten
`@deepseek-ai/dsh*` peers, with `@deepseek-ai/cordis` widened to
`~4.0.4 || ~4.0.5-alpha.1` and `@deepseek-ai/schemastery` to
`~3.18.4 || ~3.18.5-alpha.1`. The two vendor peers are outside DSH's own peer
check — it reads only `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` — so their
ranges matter only to npm's install-time resolution, which runs without
`includePrerelease`; naming both vendored prereleases keeps a clean install on
either host. `devDependencies` stay pinned to `0.2.0-rc.2`.

The consequence is deliberate: `evaluatePluginCompatibility` runs before a
profile is composed on every start, so the next DSH release will refuse to
activate this plugin until the list is widened by an audit. That reversal of the
2026-09-29 policy is recorded in `docs/决策记录.md` (章节一, 条目2).
`tests/compatibility-metadata.test.ts` now asserts both admissions, fifteen
rejections, and the two vendor ranges.

### Host-side changes with no plugin impact

`packages/schedule/schedule/**` has no changed source; the schedule error-code
table is identical, so `src/wire-errors.ts`'s twelve mappings (including
`subagent_session → E_PROTOCOL`) stay correct. No session-log format migration
exists — `session-format*`, `v0-to-v1`…`v3-to-v4`, `session-persistence`,
`session-projection*`, `session-log-deepseek` changed only their version and
locale files — so phone history rendering is unaffected. The subagent descriptor
is still version 3. `host/webserver`'s `port` widening, the macOS directory
picker, the PTC call registry, and the new `job/registered` / `job/settled`
events are all unreachable or safely skipped by this plugin (`projectEvent`'s
`default: return null`). Settings surfaces are unchanged at the contract level:
`ui-settings`'s `settings.section` slot has the same SHA as alpha.2, and
`configForms.get()` kept its name. The Web composition still mounts
`schedule`/`ui-schedule`, and `directory-picker` is still disabled in place, so
the plugin's three `cordis.patch.yml` rows still land.

### Validation evidence

- **Config schema on the published CLI:** isolated `DSH_HOME`, `dsh
  --profile deeppilot-audit --from-default-profile sdk-minimal
  --dump-config-schema --patch cordis.patch.yml` against
  `@deepseek-ai/dsh@0.2.1-alpha.3` → exit 0, 179,851 bytes, the plugin entry at
  `/37` reports `status: 'schema'` with `configRef: #/$defs/config24`, all seven
  volatile assertions pass, no `deeppilot`-attributed diagnostic, and the only
  warning is the `sdk-minimal` template's own missing `directory-picker` row.
- **Web composition:** the same CLI composed a real Web profile with the plugin
  patch → **1225 rows versus 1214 without it**, the plugin's three rows present
  at `deeppilot-directory-picker-browse` / `…-browse-client` / `deeppilot`, and
  zero `unrecognized Loader tree carrier` entries on either side.
- **Plugin unit tests:** `npx tsx --test tests/*.test.ts` → **562 tests, 561
  pass, 0 fail, 1 todo**, including the six new contract tests. `npm run
  typecheck`, `npm run build`, and `npm run check:config-schema` (against the
  pinned `0.2.0-rc.2` CLI) all pass with regenerated `lib/`.
- **Live A/B on a real `0.2.1-alpha.3` host — the evidence that matters.** An
  isolated `DSH_HOME` profile built from the shipped Web template and linked to
  this working tree booted under the published alpha.3 CLI (`--port 3180`; the
  default 3080 was already held by this machine's own Host). The **unfixed**
  `0.9.4` build printed
  `[deeppilot] DSH Remote interaction client unavailable:
  @deepseek-ai/dsh-typert-registry/client Client bundle returned no exports`
  and the fixed build printed no such line. The checklist itself scored
  **23 pass / 1 fail / 4 skipped in both runs** — see the blind spot below.
- **The regression checklist does not cover this seam.** `scripts/smoke-live.mts`
  scored identically before and after the fix, because the resident Client it
  exercises is only reachable through the approval/question waterfall, and step
  10 is skipped without `--interactions`. The observable difference is the Host
  log line and the phone's approval/question delivery, not a checklist step. A
  future revision should assert on that diagnostic directly.
- **Backward compatibility, same working tree:** the same profile booted under
  the published `0.2.1-alpha.2` CLI (`--port 3181`) scored **25 pass / 0 fail /
  0 warn / 3 skipped** with no interaction-client diagnostic — the same result
  the alpha.2 audit recorded, so the fix does not regress the host users run
  today.
- **One checklist difference between the two host versions is real.**
  `模型目录可读` passes on alpha.2 and fails on alpha.3 in the same isolated
  home (`0 provider / 0 model, routable=true`): this release stops listing a
  pi-ai route before its credential resolves and returns only the version-gated
  subset for the account route. The home has no model credential, so the phone's
  model list is empty there. That is the documented behavior change, not a
  plugin defect.
- **Artifact inspection:** the `node`/`browser` conditional exports and the
  banner counts above were read from the installed alpha.3 packages, not from
  the diff.

### Host-side migrations this machine must apply

Neither is a plugin defect, and neither is fixed by the plugin change:

1. **`llm-deepseek-account`'s retired `models` key.**
   `~/.dsh/profiles/web/cordis.patch.yml:77-79` sets `models: []`.
   `resolveAccountOptions` throws for *any* own `models` key
   (`llm-deepseek-account: models is no longer configurable…`), and the
   upstream test pins `[{ models: [] }, /models is no longer configurable/]`.
   The empty array is not exempt. The `desktop` profile's row carries no
   `config` and is unaffected. Whether the throw takes the whole Host down or
   only retires that route was **not** measured — the guide says the account
   models stop appearing either way.
2. **`--from-default-profile` now replaces.** It stages a fresh copy over the
   target and deletes the previous directory, including `node_modules` and the
   user's own `cordis.patch.yml`. The re-audit procedure below and the alpha.2
   entry's schema command both use that flag; from now on it must be pointed at
   a scratch name.

Checked and **not** required: Azure provider rename (no `azure` /
`azure-openai-responses` key exists under `~/.dsh/profiles`), credential-file
extra keys (the file's top level is already `version`/`refs`/`records`), and
the stored-credential precedence flip (no `refs` name is exported in the shell,
and the stored value won precedence over `.env` on both sides of the change).

### Still unverified

- Whether breaks 1 and 2 surface inside `dsh-api-proxy.ts`'s catch or escape it
  as an unhandled rejection — the Gateway opens its Remote Events generation
  asynchronously, after `startDshRemoteInteractions` has already returned.
- Whether an old profile that predates `@deepseek-ai/dsh-api-remote-access`
  still gets the row (the shipped Web template does; `dsh-base` carries it).
- How the reshaped `contextBreakdown` renders on iOS, and what the phone shows
  for the unmapped `CLIENT_UPGRADE_REQUIRED` / `MODEL_UNSUPPORTED` codes.
- Whether the plugin's own `lib/client.js` (banner shape, `dsh.client.inject`,
  `platform: web`) is still accepted by alpha.3's client-modules scanner; that
  scanner lives in `packages/client/modules` and `packages/client/web`, which
  were not read in full.

### Re-audit procedure used

Fetch the new tag into the existing blobless clone at `.audit-dsh-alpha2`
(`git fetch --filter=blob:none --no-tags origin
'+refs/tags/<tag>:refs/tags/<tag>'`, ~3 s), slice
`git diff --name-status` per package, and write each slice's content diff to a
file before parallel reading — blobless clones fetch blobs on demand, so one
`git diff` per region is far cheaper than many small reads. Reproduce a
suspected carrier break against the **published** `lib/` bundles with a stub
`this`, as above, rather than trusting either the diff or the release notes.
`npm --cache <workspace dir>` is still required; `~/.npm/_cacache` holds
root-owned files and fails `npm view` with `EPERM`.

## 2026-10-09 — audit of `dsh-v0.2.1-alpha.2`

### Scope and method

Compared `dsh-v0.2.1-alpha.1...dsh-v0.2.1-alpha.2` (**669 commits, 3226 changed
files, 114,987 insertions, 28,177 deletions**) from a full clone
(`git clone --filter=blob:none --no-checkout`, unshallowed before measuring).
Baseline SHA `5badb150`, target SHA `d7432673`, annotated tag object `6851e496`.
Peer package names were mapped to monorepo paths by reading every `package.json`
in the tree, then each peer package's `src/**/*.ts` was diffed with
`git diff --name-status`. Every changed source file under `packages/api`,
`packages/session*`, `packages/client`, and `packages/core` was read in full —
including the complete 836-line session-controller diff — rather than being
summarised from release notes. All **20** upgrade guides added since the last
audit (19 under `docs/upgrade-guide/v0.2.1-alpha.1/` plus `bundled-python-tests`
under `v0.2.0-rc.2/`) were read in Chinese in full, and each one that could touch
an integration seam was traced to its implementation before being judged. No
guide from an earlier release was modified between the two tags.

### Peer packages: 2 of 12 changed source

| Package | Path | Changed `src/` files |
| --- | --- | --- |
| `@deepseek-ai/dsh` | `apps/cli` | 1 (`src/args.ts`) |
| `@deepseek-ai/dsh-client-connection` | `packages/client/connection` | 5 (`api-request-trust.ts`, `browser-auth.ts`, `index.ts`, `rpc-host.ts`, `rpc.ts`) |
| `@deepseek-ai/dsh-api-gateway` | `packages/api/gateway` | 0 |
| `@deepseek-ai/dsh-api-remotes` | `packages/api/remotes` | 0 |
| `@deepseek-ai/dsh-client-locale` | `packages/client/locale` | 0 |
| `@deepseek-ai/dsh-client-ui-settings` | `packages/client/ui-settings` | 0 |
| `@deepseek-ai/dsh-client-ui-slots` | `packages/client/ui-slots` | 0 |
| `@deepseek-ai/dsh-settings` | `packages/settings/settings` | 0 |
| `@deepseek-ai/dsh-typert-protocol` | `packages/typert/protocol` | 0 |
| `@deepseek-ai/dsh-typert-registry` | `packages/typert/registry` | 0 |
| `@deepseek-ai/cordis` | `vendor/cordis` | 0 |
| `@deepseek-ai/schemastery` | `vendor/schemastery` | 0 |

`react` is not an upstream package and was not measured. Two non-peer packages
that the bridge reaches through `ctx.get` did change and are covered below:
`packages/api/session-controller` and `packages/client/connection`.

### The one confirmed break

`packages/api/session-controller/src/index.ts` started dereferencing a parameter
that upstream's own published declaration already marks as required:

```ts
async projections(request: SessionProjectionsRequest, signal: AbortSignal): Promise<SessionProjectionsValue> {
  const { sessionId } = request
  if (sessionId.length === 0) throw new RemoteError('gateway/bad-request', ...)
  try {
    signal.throwIfAborted()                                   // now the first statement
    const live = this.liveProjections(sessionId)
    ...
  } catch (error) {
    ...
    if (signal.aborted || ...) throw new RemoteError('gateway/cancelled', ...)   // now unconditional
    ...
  }
}
```

In alpha.1 the same method only forwarded `signal` into `observeSession` and read
`signal.aborted` inside the `catch`, so an omitted signal still survived the happy
path. In alpha.2 the omission throws before any work is done — reproduced against
the published `0.2.1-alpha.2` bundle with the real class, a stub context whose
live-projection path returns a value, and no signal:

```sh
# published @deepseek-ai/dsh-api-session-controller@0.2.1-alpha.2, lib/index.js
SessionController.prototype.projections.call(receiver, { sessionId: 'x' })
# → TypeError (signal is undefined at signal.throwIfAborted(), then again at signal.aborted)
SessionController.prototype.projections.call(receiver, { sessionId: 'x' }, new AbortController().signal)
# → { kind: 'sequenced', asOfSeq: 7, values: { title: 'audit' } }
```

DeepPilot's call site is `src/dsh-api-proxy.ts:235`:

```ts
projections: async (request) => this.call(() => this.session.projections(request.payload!)),
```

The hand-written mirror at `src/dsh-api-proxy.ts:45` declares `signal?` optional,
which is exactly what let the omission typecheck; the upstream declaration
(`@deepseek-ai/dsh-api-session-controller@0.2.1-alpha.2`,
`lib/types/index.d.ts:209`) requires it. `DshApiProxy.call()`
(`src/dsh-api-proxy.ts:413`) converts the `TypeError` into
`{ ok: false, error: { code: 'internal' } }`, so this degrades rather than
crashes: `HostBridge.refreshProjections` (`src/host-bridge.ts:799`) already treats
a failed baseline as a diagnostic and logs
`sessions.projections failed: internal`.

**Observable effect.** The phone's session summary loses the on-open complete
projection baseline. It still receives title, todo counts, and token usage from
the session list rows' cached projections (`src/dsh-api-proxy.ts:458`,
`src/host-bridge.ts:1546`) and from live `session/projection` frames
(`src/host-bridge.ts:453`), so nothing breaks outright; the loss shows up on
hosts where the baseline read was the only source — a session whose list row
carries no cached projections stays without those values longer than it should.
Cold history reads are **not** affected: they run through
`inspect(sessionId)`, whose signal is still optional upstream.

**Fix (applied 2026-10-10).** The adapter now passes a signal the way `list` and
`prompt` already do —
`this.session.projections(request.payload!, new AbortController().signal)` — and
the mirror's `signal` is required, so the compiler keeps it that way.
`refreshProjections` is fire-and-forget and has no cancellation source of its
own, so a dedicated long-lived controller is not warranted; following the
existing convention in the same file is enough. `lib/index.js` was regenerated.

The fix ships in `0.9.4`, published 2026-10-10 (see "Plugin release verdicts").
A host on `0.2.1-alpha.2` left on the published `0.9.3` still loses the on-open
projection baseline. That was observed directly: on a live `0.2.1-alpha.2` host
running published `0.9.3` the diagnostic appeared, and on the same host version
running this build it did not (see "Live run on a real `0.2.1-alpha.2` host"
under Validation evidence).

`tests/dsh-api-proxy.test.ts` adds "projection baseline reads pass the
AbortSignal the Host now requires": a controller stub that calls
`signal.throwIfAborted()` before returning, plus an assertion that the adapter
handed it a real `AbortSignal`. The test was verified red against the previous
call form (1 failure) and green after the fix, so it pins the behaviour rather
than the implementation coincidence.

### Other session-controller changes, checked against this plugin

`Where` names the upstream `packages/api/session-controller/src/` file unless it
says otherwise; `lib/types` means the published declarations of
`@deepseek-ai/dsh-api-session-controller@0.2.1-alpha.2`.

| Change | Where | DeepPilot impact |
| --- | --- | --- |
| `projections` return type is now a union: `{ kind: 'sequenced', asOfSeq, values }` / `{ kind: 'migration-required', values }` / `null` | `src/index.ts:506-541` | The mirror's flat `{ asOfSeq, values }` type is now narrower than upstream, but the plugin reads only `values`, so a successful read still folds. Type-mirror drift, not a runtime defect. |
| `inspect(sessionId, signal?)` | `packages/session/session-query` | Signal is still optional in the published declaration, so the plugin's `inspect(sessionId)` call keeps working. Cold log reading, scanner row decoding, and the V4 codec path were read and are unchanged for this caller. |
| `search(request, signal)` requires a signal | `lib/types/index.d.ts:93` | The plugin never calls `search`. |
| `page(request, signal)` requires a signal | `src/index.ts:1412` | Not called; history paging still goes through `inspect`. |
| `fork` gains `allowMigration` (default `true`) | `src/index.ts` | The plugin does not send it, so the upstream default keeps automatic migration. The new `session/migration-required` error is unreachable from the phone. |
| `skill-catalog` injects `workingDirectory` and lists skills by execution directory | `src/skill-catalog.ts` | Not consumed; the plugin lists no skills. |
| Session ownership helper | `packages/api/session-controller` | Unchanged; `session/agent-busy` still maps to `E_BUSY`. |
| Subagent catalog v2 `mode: 'external'` | `packages/subagent/subagent` | Descriptor version is still 3 and the earlier one-shot read types are retained; the plugin filters by origin/parent and does not fold catalogs. |

### Connection carrier: unchanged on the paths this plugin uses

`packages/client/connection` gained five changed source files, including a new
`api-request-trust.ts` and browser-auth changes. Those trust, authentication, and
TLS checks run through `requestRejection`/`admit`, which guard **physical**
requests. The plugin's resident client uses
`connection.createSharedFetchHandler('/api')`, which dispatches routes directly
and never calls `admit` (`packages/client/connection/src/rpc-host.ts:136-154`), and
its stream call keeps the
five-argument `wireStream.open(endpoint, payload, uplink, peer, signal)` order.
The plugin's own LAN TLS pin check and `/phone` listener are unaffected.

### Four-way comparison at `0.2.1-alpha.2`

| Surface | Both sides | Upstream has, plugin does not consume | Plugin has, upstream does not |
| --- | --- | --- | --- |
| Session RPCs | `list`, `inspect`, `create`, `fork`, `rename`, `cancel`, `prompt`, `attachment`, `selectModel`, `modelCatalog`, `projections` | `search`, `page`, `follow`, `updateQueue`, `initializeDefaultModel`, `canOpenWorkspacePath`, `openWorkspacePath`, `workspacePathApplications` | phone-shaped `sessions.*` envelope, history windowing, projection folding, notification suppression |
| Workspace RPCs | `create`, `archiveSession`, `unarchiveSession`, `follow` | `initializeDefault`, `rename`, `delete`, `insertBefore`, `insertSessionBefore`, `pinSession`, `unpinSession` | archived mirror, `sessionRestore` capability bit |
| Directory picker | `list`, `pick` | `createDirectory` | browse host/client patch rows, phone-side directory browsing |
| Schedule | `list`, `history`, `create`, `update`, `delete` | `catalog`, stream delivery modes | phone schedule frames, `schedule.manage` scope, prompt-free mutation journal |
| Projections | reading `values` | `workingDirectory`, `formatStatus`, the migration-required branch | `title` / `todos` / `sessionStats` / `tokenUsage` folding |
| Subagents | — | `prompt`, `interruptByParent`, catalog v2 | subagent-session exclusion and notification policy |
| Trust and auth | shared Fetch route dispatch, TLS pin check | `webStartup.trustedHosts`, listener-address validation | device records, pairing tokens, signed challenge |

Rows marked "upstream has, plugin does not consume" are capability gaps by
choice, not regressions: none of them changes a call the bridge already makes.
`neither side` is empty for every row that matters to the phone.

### Validation evidence

- **Unit tests:** `tsx --test tests/*.test.ts` → **537 pass, 0 fail, 0 skipped**
  on the source diff alone. After the adapter fix and its new regression test the
  same command reports **538 pass, 0 fail, 0 skipped**, and `npm run typecheck`
  and `npm run build` pass with regenerated `lib/`.
- **Config schema on the published CLI:** an isolated `DSH_HOME` and npm cache ran
  `dsh --profile deeppilot-audit --from-default-profile sdk-minimal
  --dump-config-schema --patch cordis.patch.yml` against
  `@deepseek-ai/dsh@0.2.1-alpha.2` → the plugin entry reports
  `status: 'schema'` with its own `$defs` config, the volatile-field checks pass,
  and the only warning is the `sdk-minimal` template's own missing
  `directory-picker` row.
- **Web composition:** the same CLI composed a real Web profile with the plugin
  patch → 188 rows versus 185 without it; the plugin's three rows
  (`deeppilot-directory-picker-browse`, `…-browse-client`, `deeppilot`) are
  present with the plugin config schema at `#/$defs/config100`. The four
  `unrecognized Loader tree carrier` errors the dump prints at `/181`–`/184`
  reproduce **identically without** the patch, so they belong to the base Web
  profile and not to this plugin.
- **Published client bundles:** the two resident-client tests
  (`tests/dsh-wire-stream-contract.test.ts`) were re-run against the actual
  published `0.2.1-alpha.2` client bundles, resolved through a temporary
  resolution hook instead of the rc.2 dev pins → pass. This covers client-face
  composition and the stream's abort-signal argument contract with a **mocked**
  Host gateway.
- **Documentation corrected in the same change:** `COMPATIBILITY.md`,
  `PROTOCOL.md`, `docs/DEEPPILOT_FEATURE_PLAN.md`, and the schedule-service
  comment in `src/dsh-api-proxy.ts` no longer tell users to enable a retired
  bundle. The private app's schedule-unsupported strings still do; that copy
  lives in the other repository and is listed as an open follow-up above.
- **Live run on a real `0.2.1-alpha.2` host (2026-10-10).** An isolated
  `DSH_HOME` (`.audit-smoke-home`, workspace root) was given a `smoke` profile
  built from the shipped Web template with this working tree linked in, plus a
  second profile pinning the published `dsh-deeppilot@0.9.3`. The published
  `0.2.1-alpha.2` CLI booted each one in turn and
  `scripts/smoke-live.mts run` drove the phone protocol against it over the LAN
  TLS listener (no `--prompt`, so no model turn). **Both runs: 25 pass / 0 fail /
  0 warn / 3 skipped** — health, TLS SPKI, pairing rejection, WSS upgrade,
  challenge/prove with all six scopes, session list/create/open/history,
  model catalog and switch, workspace list/create, archive/unarchive, pending
  snapshot, the full schedule create/history/delete flow, and reconnect replay.
  The skips are the log-pin cross-check (needs `SMOKE_LOG`), the real prompt, and
  the approval/question round trip.
- **The A/B result is the evidence that matters.** The published `0.9.3` host
  logged `[deeppilot] sessions.projections failed: internal` while still passing
  every checklist step, which is exactly the silent degradation predicted above;
  the working-tree build, same checklist, same host version, logged **zero**
  `sessions.projections` lines. The defect and the fix are therefore both
  confirmed at runtime on `0.2.1-alpha.2`, not only in unit tests.
- **The live run also settles the automation question.** The welcome frame on a
  stock Web profile advertised `schedules: true` with no bundle enabled and no
  user action, and the full schedule create/history/delete flow passed against
  it. That is the behaviour the corrected `COMPATIBILITY.md`, `PROTOCOL.md`, and
  feature-plan copy now describe.
- **Still untested:** a real model turn inside the plugin's live path (the
  isolated home has no model credentials), the Funnel/remote transport (the
  isolated host ran `remote.enabled` at its default `false`; the live host's
  phone path goes through the Funnel helper), and a real iPhone. The live smoke
  gate still refuses to run against the machine's own host without a restart,
  because `DeviceStore` snapshots `devices-v2.json` once at mount.
- **Repository pins unchanged:** `npm run check:config-schema` and the CI
  `config-schema` job still target the `0.2.0-rc.2` CLI. The alpha.2 schema dump
  above was run separately in an isolated home instead of re-pinning the
  repository's own gate, so the gate keeps reporting its `0.2.0-rc.2` baseline
  and nothing in the working tree depends on alpha.2.

### Re-audit procedure used

The same full-clone method as the alpha.1 entry, with one addition: because two
non-peer packages (`api/session-controller`, `client/connection`) carry the
integration seams this plugin depends on, the diff was extended past the peer
set and every changed source file in `packages/api`, `packages/client`,
`packages/session*`, and `packages/core` was read in full. Judging only the peer
list would have missed the `projections` break entirely — the peer-list check
reported 10 of 12 packages clean while the defect sat in a package reached
through `ctx.get('sessionController')`.

## 2026-10-03 — audit of `dsh-v0.2.1-alpha.1`

### Scope and method

Compared `dsh-v0.2.0-rc.2...dsh-v0.2.1-alpha.1` (**266 commits, 4190 changed
files**) from a fresh blobless clone
(`git clone --filter=blob:none --no-checkout`), unshallowed before measuring.
Package names were mapped to monorepo paths by reading every `package.json`
through a sparse checkout, then each package's `src/` was diffed with
`git diff --name-status`. Baseline SHA `639ed015`, target SHA `5badb150`.

### Peer packages: 12 of 12 have zero changed source

Every peer package this plugin declares in `package.json` changed **only** its
`package.json` and its READMEs. No `src/` file moved:

| Package | Path | Version | Changed `src/` files |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh` | `apps/cli` | `0.2.0-rc.2` → `0.2.1-alpha.1` | 0 |
| `@deepseek-ai/dsh-api-gateway` | `packages/api/gateway` | `0.2.0-rc.2` → `0.2.1-alpha.1` | 0 |
| `@deepseek-ai/dsh-api-remotes` | `packages/api/remotes` | `0.2.0-rc.2` → `0.2.1-alpha.1` | 0 |
| `@deepseek-ai/dsh-client-connection` | `packages/client/connection` | `0.2.0-rc.2` → `0.2.1-alpha.1` | 0 |
| `@deepseek-ai/dsh-client-locale` | `packages/client/locale` | `0.2.0-rc.2` → `0.2.1-alpha.1` | 0 |
| `@deepseek-ai/dsh-client-ui-settings` | `packages/client/ui-settings` | `0.2.0-rc.2` → `0.2.1-alpha.1` | 0 |
| `@deepseek-ai/dsh-client-ui-slots` | `packages/client/ui-slots` | `0.2.0-rc.2` → `0.2.1-alpha.1` | 0 |
| `@deepseek-ai/dsh-settings` | `packages/settings/settings` | `0.2.0-rc.2` → `0.2.1-alpha.1` | 0 |
| `@deepseek-ai/dsh-typert-protocol` | `packages/typert/protocol` | `0.2.0-rc.2` → `0.2.1-alpha.1` | 0 |
| `@deepseek-ai/dsh-typert-registry` | `packages/typert/registry` | `0.2.0-rc.2` → `0.2.1-alpha.1` | 0 |
| `@deepseek-ai/cordis` | `vendor/cordis` | `4.0.4` → `4.0.5-alpha.1` | 0 |
| `@deepseek-ai/schemastery` | `vendor/schemastery` | `3.18.4` → `3.18.5-alpha.1` | 0 |

The only non-manifest, non-README change inside a peer package is a **new test
case** in `packages/api/gateway/tests/gateway.host.spec.ts`, which records a
behaviour fix: a Service already disposed is skipped during SRC resolution. No
shipped code changed, so `typertGateway.wireStream.open(endpoint, payload,
uplink, peer, signal)` keeps its argument order — the seam this plugin's
highest-risk integration depends on.

### High-risk service surfaces

| Area | Finding | DeepPilot impact |
| --- | --- | --- |
| `api/session-controller` (`src/index.ts`, `src/list.ts`) | Adds one optional config key `listWorkSliceMs` (natural, min 1, **default 16**) and threads it into `new ApiSessionList(ctx, resolved.listWorkSliceMs)` so large listings yield between rows. No `@Remote` method signature changed. | None. The hand-written `SessionControllerLike` mirror still matches; the plugin never constructs the controller. |
| `api/workspace-controller` | Zero changed `src/` files. | None. |
| `schedule/schedule` | `src/tools.ts` and `src/invariant.ts` **deleted**; `ScheduleService.inject` drops `'tools'`; `src/types.ts` gains `SubagentSessionError`. | See the two rows below. |
| `boot/app-boot` | `createRuntimeResolution` now returns a `ProfileRuntimeResolution` **class instance** instead of a frozen plain object, and a new `RETIRED_BUNDLES` set exists. | None. `app-boot` is not in this plugin's peer set. |

### The three announced breaking changes, checked against this plugin

Each was traced to its implementation in the DSH tree rather than accepted from
the release note.

| Breaking change | Where it actually lands | DeepPilot impact |
| --- | --- | --- |
| **Runtime invariant plugins and every `./invariant` export removed.** | `@deepseek-ai/dsh-invariants`, `InvariantRegistry`, `InvariantInstaller` and all `<package>/invariant` subpaths stop being published; `sdk-minimal` drops five rows. Official guide: `docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/`. | **None.** The plugin source contains zero `invariant` references. In `package-lock.json` the package appears only as a transitive dependency of `dsh-credentials`, `dsh-scope`, `dsh-settings` and `dsh-system-prompt` — packages this plugin does not import or configure. `cordis.patch.yml` declares no invariant rows, so no `patch: entry ... not found` warning can occur. |
| **Subpath plugins no longer read their own `package.json`; text and icon must come from subpath exports.** | `boot/app-boot/src/package-meta.ts`: `manifestPath` is now `packageName === specifier ? optionalResourcePath(...) : undefined`, so only a package-root specifier reads a manifest; a subpath instead takes its icon from an exported `<specifier>/icon`. A new `assertPackageOwned` keeps an exported icon inside its owning package. Official guide: `docs/upgrade-guide/v0.2.0-rc.2/subpath-plugin-display-manifest/`, which states the affected group is "authors who export a subpath `package.json`". | **None.** `package.json` exports `./package.json` (package root) but **not** `./client/package.json`, and the root manifest still supplies `name`, `description` and `icon.svg`. Verified against Node's real exports gate in this repo: `dsh-deeppilot/client/package.json`, `dsh-deeppilot/client/icon` and `dsh-deeppilot/client/locale/en.json` all fail with `ERR_PACKAGE_PATH_NOT_EXPORTED` **today**, so the old code could never have resolved them either. Old and new resolution therefore produce the same result. |
| **Composer statistics split into `activity` and `usage` entries; plugins overriding the old `stats` row must change their registered ID.** | The `stats` composer row was reworked (the `composer-session-stats-pills` design note is archived). | **None.** The plugin registers exactly one client extension — `slots.inject('settings.section', ...)` in `src/client/index.ts:478` — and never registers a composer row. The `row.stats` at `src/host-bridge.ts:663` is this plugin's own wire structure, unrelated to the composer extension. |

### Automation tasks moved into the Web composition

This is the one substantive product change, and it invalidates documentation
rather than code.

`boot/app-boot/src/profile.ts` adds:

```ts
const RETIRED_BUNDLES: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-experimental-schedule-bundle',
])
```

and removes that bundle from `OPTIONAL_BUNDLES` (replaced by
`@deepseek-ai/dsh-experimental-inspector-profile`). `loadProfileDirectory`
rewrites the profile's `package.json` to drop the retired entry; stored tasks and
delivery records survive on disk. The official guide
(`docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/`) states that
`@deepseek-ai/dsh-web-app` now mounts `schedule` and `ui-schedule` in **every**
Web profile.

The plugin needs no code change. It resolves the service lazily through
`ctx.get('schedule')` (the fix recorded in the 2026-09-29 entry), never lists
`schedule` in `inject`, and already reports `E_UNSUPPORTED` when the service is
absent. On a `0.2.1-alpha.1` Web profile the service is simply always present,
so `welcome.capabilities.schedules` becomes `true` by default instead of by
opt-in.

What is now wrong is the instruction the plugin gives users. `PROTOCOL.md`
(line 899), `COMPATIBILITY.md` (lines 39–47), `docs/RELEASE_NOTES-0.9.0.md`, and
`docs/DEEPPILOT_FEATURE_PLAN.md` all tell the user to enable **Automation tasks**
in the plugin manager, and the iOS copy repeats it. On this release that entry is
retired and auto-cleaned, so the instruction sends users after a bundle that no
longer exists.

The upgrade guide's migration step 2 — keep `schedule`/`ui-schedule` overrides in
a patch layer and delete a top-level `time-context` override — **does not apply
here**: `cordis.patch.yml` is 20 lines long and contains only the three
directory-picker rows, with no `schedule`, `ui-schedule` or `time-context`
entries.

### New Schedule refusal: `subagent_session`

`ScheduleService` now refuses `create` and `update` when the target Session has
a delegation depth above zero, returning a new stable `ScheduleInputError`
code `subagent_session` ("This Session belongs to subagent routing, which never
receives reminder delivery"). `delete` deliberately still works so tasks stored
before the rule existed stay removable. The refusal is also visible to subagents
because the bridge reaches this code through the same `@Remote` methods.

`src/wire-errors.ts` now maps twelve Schedule codes, adding `subagent_session` →
`E_PROTOCOL` alongside `schedule_not_found`, `invalid_selector`, `not_future`,
`frequency_too_high`, `schedule_ended` and the rest. It was chosen over
`E_UNSUPPORTED` because the capability exists on the host — it is this request's
target that can never be satisfied, so a phone retry is pointless — which puts it
in the same class as the other input-shaped Schedule refusals. Without the
mapping `wireErrorOf` falls through to `WIRE_ERROR_FALLBACK` (`E_INTERNAL`), which
would tell the client the failure was worth retrying.

### Cross-platform trap found while shipping 0.9.2

CI's `plugin` job hung on `npm test` four times while shipping 0.9.2. Worth
recording because macOS could never reproduce it and the fix is one line each.

`tests/journal-parity.test.ts` used `join('/proc/definitely/not/writable', …)`
as its "unwritable path" probe, in two places. `/proc` is a Linux-only pseudo
filesystem: on macOS the path simply does not exist, so the branch had only ever
been exercised on macOS and had never run on Linux at all. On Linux, writing
under `/proc` does not return an error — and because `dispatch-journal`'s
`save()` is entirely synchronous `fs` calls (`mkdirSync`/`openSync`/
`writeFileSync`/`fsyncSync`/`renameSync`), a single write blocks the whole event
loop. Even `setTimeout` stops firing, and node's `--test-timeout` can only report
a file-level timeout. Both sites now build the unwritable target inside the
scratch directory (a file-with-a-child shape that yields `ENOTDIR` identically on
every platform); recorded values are unchanged because all three candidate paths
returned the same status on macOS.

Two lessons for future audits: the workflow sets no `timeout-minutes`, so a hang
costs the full 6-hour default before failing — cancel and re-run rather than
waiting; and reproduce Linux-only behaviour in a container instead of inferring
it. `docker run --rm --cpus=2 -v $PWD:/app -w /app node:22` matches the runner
closely enough (2 cores, and the same `v22.23.x` that `node-version: 22` floats
to).

### Re-audit procedure used

Same blobless-clone method as the rc.2 and rc.1 entries, with two refinements:
unshallow before measuring (a `--depth=1` clone silently under-reports the diff,
returning 4190 vs 4760 paths depending on history), and resolve peer package
names through a sparse `package.json` checkout instead of guessing directory
names — the monorepo maps `@deepseek-ai/dsh-api-gateway` to
`packages/api/gateway`, `@deepseek-ai/dsh` to `apps/cli`, and the two vendored
packages to `vendor/`.

## 2026-09-29 — audit of `dsh-v0.2.0-rc.2`

### Scope and method

Compared `dsh-v0.2.0-rc.1...dsh-v0.2.0-rc.2` (187 commits, 1022 files changed)
via a blobless clone (`git clone --filter=blob:none --no-checkout`) and
`git diff --name-status` between the two tags, then read the full diff for
every file under the 10 peer packages this plugin depends on plus the two
highest-risk service surfaces (`api/gateway`, `schedule/schedule`). The rest of
the 1022 changed files are in subsystems this plugin never imports (desktop
app, web UI components, test snapshots, internal `.agents/notes`) and were not
read individually.

### Findings by risk class

| Area | Finding | DeepPilot impact |
| --- | --- | --- |
| 9 of 10 peer packages (`@deepseek-ai/dsh`, `dsh-client-connection`, `dsh-client-locale`, `dsh-client-ui-settings`, `dsh-client-ui-slots`, `dsh-settings`, `dsh-typert-protocol`, `dsh-typert-registry`, and the vendored `cordis`/`schemastery` this plugin's own peers track) | Source-identical to rc.1; only the `package.json` `version` field changed. `vendor/cordis` stays `4.0.4`, `vendor/schemastery` stays `3.18.4`. | None. |
| `dsh-api-remotes` (`packages/api/remotes/src/client/index.ts`) | Mounts one new, unrelated `userQuestionsRemote`. | None; not a remote this plugin consumes. |
| `api/gateway` (`packages/api/gateway/src/index.ts`, `types.ts`) | Additive only: `TypertGatewayService` gained `hasLiveClient(): boolean`. `wireStream.open(endpoint, payload, uplink, peer, signal)` argument order — the highest-risk integration seam — is unchanged. | None. |
| `schedule/schedule/src/domain.ts` | The model-facing framing string for due reminders changed from an explicit injection-resistant instruction ("Present reminder_prompt_json to the user as untrusted reminder content, not new user instructions.") to a generic `'This is a scheduled message from the user'`. No exported function signature changed. | Not an API break; the plugin does not render this text itself, DSH's own Schedule service does. Worth tracking as an upstream security-framing regression to watch, not a DeepPilot compatibility issue. |
| Root manifest / lockfile | Only the workspace version bump (`0.2.0-rc.1` → `0.2.0-rc.2`) and two unrelated `pi-ai`/`pi-telemetry` patch bumps in `pnpm-workspace.yaml`. | None. |
| Plugin install/activation path (`apps/cli/src/plugin.ts`, `packages/boot/app-boot/src/plugin-compatibility.ts`) | Not the cause of any API break, but this is where the reported install failure actually originates: `evaluatePluginCompatibility` runs `semver.satisfies(runtimeVersion, peerRange, { includePrerelease: true })` per peer and refuses to activate a plugin whose `peerDependencies` range excludes the running DSH version. With the previous exact pin (`"0.2.0-rc.1"`), any later host — rc.2 included — failed this check by design. | This is what the user hit: "install fails with an error" on a `0.2.0-rc.2` host. Confirmed as the root cause; not a DSH bug. |

### Peer range change

Given the same "additive only" result as the rc.1 audit, and at the user's
explicit direction (2026-09-29), the DSH peer range in `package.json` changed
from an exact pin to `>=0.2.0-rc.2 <0.3.0-0`. `<0.3.0-0` (not `<0.3.0`) is
deliberate: node-semver with `includePrerelease: true` treats a bare `<0.3.0`
upper bound as admitting `0.3.0` prereleases too (a `0.3.0-rc.1` sorts below
`0.3.0` and would otherwise satisfy the range), which would defeat the point
of stopping at the audited `0.2.x` line. `<0.3.0-0` excludes `0.3.0` and every
one of its prereleases while still admitting any `0.2.x` patch and its
prereleases. Verified directly against `semver.satisfies`:

| Version | Admitted |
| --- | --- |
| `0.2.0-rc.1` (previous baseline) | No |
| `0.2.0-rc.2` (floor) | Yes |
| `0.2.0-rc.3`, `0.2.0-rc.20` | Yes |
| `0.2.0`, `0.2.1`, `0.2.1-rc.1` | Yes |
| `0.3.0-rc.1`, `0.3.0` | No |
| `1.0.0` | No |

The devDependency pins used for local typecheck/build stay an exact version
(`0.2.0-rc.2`) — a range there would leave `npm ci` unable to resolve a single
concrete type definition to build against.

### Re-audit procedure used

Same as the rc.1 entry below: blobless clone, `git diff --name-status` between
tags, and read the diff for the packages this plugin actually imports rather
than trusting release-note summaries.

## 2026-09-28 — audit of `dsh-v0.2.0-rc.1`

### Scope and method

Compared `dsh-v0.1.7-rc.2...dsh-v0.2.0-rc.1` (261 commits, 1109 files). Rather
than read release notes, every DSH package the plugin actually imports was
compared file by file: `api/session-controller` (34 files),
`api/workspace-controller` (10), `schedule/schedule` (10), `api/gateway` (11),
and `typert/protocol` + `settings/settings` (13). Release notes were treated as
a hint, never as evidence.

### Findings by risk class

| Area | Finding | DeepPilot impact |
| --- | --- | --- |
| Install | All ten peer and five dev packages publish `0.2.0-rc.1` on npm. `cordis` stays `4.0.4`, `schemastery` stays `3.18.4`, Node `engines` and pnpm `11.7.0` are unchanged. The lockfile had to be regenerated from the registry: the old one still pinned `0.1.7-rc.2` and made both `npm ci` and `npm install` fail with ERESOLVE. | Resolved. `npm ci`, typecheck, build, and the real-CLI config-schema check all pass. |
| Session / Workspace controllers | `client/contract/sessions.ts` and `client/sessions/service.ts` changed only to add an **optional** `onCreated?: (childId: SessionId) => void` to `fork()`. `workspace-controller/src/default-directory.ts` changed only to pass an extra internal `'hidden'` argument to its own `run()` helper. | Additive. The plugin's hand-written `SessionControllerLike` / `WorkspaceControllerLike` mirrors still match. |
| Schedule service | **All ten `schedule/schedule/src` files are byte-identical to rc.2.** The change is packaging, not API: see below. | The existing facade needs no change. |
| Gateway / Remote Events | **All eleven `api/gateway/src` files are byte-identical**, including `stream-protocol.ts` and `stream-server.ts`. `typertGateway.wireStream.open(endpoint, payload, uplink, peer, signal)` keeps its argument order — the order DSH changed once in 0.1.7. | The highest-risk integration seam is unchanged. Approval and question delivery re-run clean on the new baseline. |
| Typert / settings | `typert/protocol` and `settings/settings` sources are byte-identical, so `TypertRemoteService`, `InvocationDescriptor`, `TypertCodec`, `TypertRemoteContribution`, `TypertSchema`, and `configForms.get` are all unaffected. | No change. |
| Phone protocol | No DSH-facing wire change. Protocol v2, `schedule.manage` scope, and the mutation journal are untouched. | Paired phones keep working. |

### Automation is now an optional bundle

The shipped `packages/bundle/web-app/cordis.patch.yml` in rc.2 carried
`time-context`, `schedule`, and `ui-schedule` at lines 118–126 and 370–371. In
0.2.0-rc.1 that file contains no schedule rows at all. Those three rows are now
inserted by `packages/experimental/schedule-bundle`
(`@deepseek-ai/dsh-experimental-schedule-bundle`), which `OPTIONAL_BUNDLES` in
`packages/boot/app-boot/src/profile.ts` ships **switched off**; the user enables
it as **Automation tasks** in the plugin manager.

This is the only substantive product change in the release. The plugin's
existing design is already correct: it resolves the service via
`ctx.get('schedule')`, never puts `schedule` in `inject`, and degrades to a
stable `E_UNSUPPORTED` with `welcome.capabilities.schedules = false`. What
changed is that a stock host now always takes that degraded path, so the iOS
copy for the two schedule errors now names the bundle instead of reporting a
generic capability gap. `PROTOCOL.md` records that the capability bit reflects
actual mounting, not the host version.

### Re-audit procedure used

To redo this comparison: `git clone --filter=blob:none --no-checkout
https://github.com/deepseek-ai/deepseek-harness.git`, fetch both tags, list each
package's `src/**/*.ts` from `git/trees/<sha>?recursive=1` at both commits, and
diff the two file sets file by file. Avoid `git grep` on a blob-filtered clone —
it re-fetches blobs and times out. Record which files are byte-identical, not
merely which packages still exist.

## 2026-09-29 — live smoke test on a real `web` profile (0.2.0-rc.1)

### How it was run

`scripts/smoke-live.mts` drives the phone protocol against a real
`dsh --profile <name> web` host that has this working copy linked in. It
asserts the seams unit tests fake out: the LAN TLS listener, the
challenge/prove handshake, and every Host RPC the bridge forwards through
`ctx.apiProxy`. It is repeatable, so the next DSH release can re-run it instead
of trusting a source diff.

```sh
npx tsx scripts/smoke-live.mts register   # pre-authorize a device, then restart the host
npx tsx scripts/smoke-live.mts run [--prompt] [--interactions]
```

The pairing-code happy path is intentionally not driven: the code only exists
inside the host process and can only be minted through the plugin's own
`deeppilot/beginPairing` Host RPC, i.e. from a DSH client session. The script
asserts instead that `/phone/pair` is mounted and refuses a bogus code, and
covers the real challenge/prove handshake with a pre-authorized device.

### Result: 25 checks pass, 0 fail

Verified on a real 0.2.0-rc.1 `web` profile: `/phone/health`, the WSS upgrade,
challenge/prove → welcome with all six scopes, session list/create/open/tail,
history paging, the model catalog and a live model switch, workspace
list/create, archive → archived list → unarchive, the pending approval/question
snapshot, a real model turn (`clientSendId` receipt `accepted`,
`message.final` + `turn.end` observed), disconnect/reconnect replay
(`resumed=true`, `s2c.resume.done` received), and — with the Automation tasks
bundle mounted — the schedule list/create/history/delete flow.

The TLS pin check is worth keeping: the bridge pins the **SPKI** digest
(`src/lan-tls.ts:35`), not the certificate DER, and the script's independently
computed pin matched the one the plugin logged on a live host.

### Finding 1 — `--patch` does not install the plugin

Composing the plugin through `dsh --profile X --patch ./cordis.patch.yml`
leaves the profile with `deeppilot: failed to import` and no reason logged.
`dsh-app-boot/lib/index.js:3904` shows why: a bare specifier in a patch layer is
never resolved into a package, so the loader never creates a fiber for it. The
plugin only mounts after `dsh plugin --profile X add dsh-deeppilot@link:<path>`.
The install docs should say so; the silent failure looks exactly like a broken
plugin.

### Finding 2 — `capabilities.schedules` stayed false even with the bundle enabled (fixed)

The optimistic reading of "Automation is now an optional bundle" above did not
hold on a real host. With
`@deepseek-ai/dsh-experimental-schedule-bundle` **installed and mounted** — the
bundle's three rows (`time-context`, `schedule`, `ui-schedule`) do reach the
composed profile, and `ScheduleService` still exposes
`create/list/catalog/history/delete/update` — welcome advertised
`schedules=false` and every `c2s.schedule.*` request took the `E_UNSUPPORTED`
path.

Root cause: the bridge is constructed from a `ctx.inject` on
`sessionController` / `connection` / `typertGateway` (`src/index.ts:1212`), and
`schedule` is deliberately **not** in that list. `DshApiProxy` then resolved
`ctx.get('schedule')` once in its constructor and cached it in a `readonly`
field. On DSH 0.2.0 those three services become ready well before
`ScheduleService` finishes its own async init, so the cached value was
`undefined` for the bridge's entire lifetime. Reordering `dsh.profile.bundles`
to mount the schedule bundle first did not help, which is what ruled out a
pure composition-order cause.

Fix: resolve the optional service lazily on every read and keep it once found
(`src/dsh-api-proxy.ts`). `capabilities` is already a getter, so a device that
connects after the service is up now gets `schedules=true`, and the full
create/list/history/delete flow passes on a live host. Covered by
`tests/dsh-api-proxy.test.ts`.

A profile that has not enabled the bundle still reports `schedules=false` and
still degrades to `E_UNSUPPORTED` — that path is unchanged.

### Finding 3 — approvals are auto-approved on a default profile

`--interactions` produced a real `tool.start`/`tool.end` pair for a "create
this file" instruction but no `s2c.pending.approval`, so the stock profile
auto-approves and the approval round trip stays unverified. The question round
trip is also unverified: dispatching a second prompt into the same session
timed out on the delivery ack. Both need a profile with a restrictive tool
policy before they can be called verified.

### Finding 4 — the archived mirror is stale right after archiving

`archiveSession` updates `archivedSessionIds` but does not call
`refreshSummaries()`, so `c2s.sessions.archived` can omit the session that was
just archived until an unrelated event triggers a refresh (it converged within
10 s in practice). Pre-existing behaviour, not a 0.2.0 regression, but the app
must not assume the archived list is immediately consistent.

## Previous decision — `dsh-v0.1.7-rc.2`

- **Audited release:** `dsh-v0.1.7-rc.2` (official release page: <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2>).
- **Plugin runtime verdict:** **no confirmed breaking change in the DSH APIs
  that DeepPilot currently calls**.
- **Install/deployment verdict:** the exact peer/dev pins and lockfile are now
  updated to `0.1.7-rc.2`; `npm test`, `npm run typecheck`, `npm run build`, and
  the rc.2 config-schema check pass locally. Support still awaits a real rc.2
  `web` profile smoke test and the release checklist's clean-install gate.
- **Protocol verdict:** no required DeepPilot phone-protocol break was found in
  the rc.2 release notes or the inspected rc.2 source. This does not waive the
  normal integration test against a real rc.2 Host.
- **Current implementation:** the optional DSH Schedule facade, schedule phone
  frames, `schedule.manage` authorization, DSH `schedule/changed` projection,
  a prompt-free persistent mutation journal, and the DSH Session fork facade
  with fork idempotency are implemented and locally tested. The private iOS
  protocol mirror, BridgeClient/AppModel integration, reminder list/editor/
  history UI, and message “Branch from here” action are implemented; real
  Host/iPhone integration remains pending.

## Evidence and risk assessment

| Area | rc.2 finding | DeepPilot impact |
| --- | --- | --- |
| Session controller | The rc.2 source still exposes the methods used by the adapter: `list`, `inspect`, `create`, `modelCatalog`, `selectModel`, `rename`, `prompt`, `attachment`, `cancel`, and `projections`. It adds `search`, `page`, `follow`, `fork`, `updateQueue`, `initializeDefaultModel`, and native workspace-path operations. | Existing calls are source-compatible at the inspected API level. New calls must remain optional and capability-gated. |
| Workspace controller | `create`, `archiveSession`, `unarchiveSession`, and `follow` remain. rc.2 adds rename/delete/order/pin operations and archive activity handling. | Existing bridge behavior is source-compatible. Archive behavior is stricter when a Session has active work, including scheduled reminders. |
| Gateway / Typert | The in-process `typertGateway.wireStream.open(endpoint, payload, uplink, peer, signal)` seam used by the resident approval/question Client remains. Typert registration still exposes `register(contribution)`. | No confirmed break in the resident Remote Events path. Re-run the approval/question tests on rc.2 because this is the highest-risk integration seam. |
| Release metadata | The plugin's peer/dev pins and lockfile now target rc.2 with real rc.2 integrity metadata. | Keep `package.json`, `package-lock.json`, compatibility assertions, generated `lib/`, and release documentation synchronized before claiming rc.2 support. |
| DSH event/history internals | rc.2 continues to evolve session projections, history paging, and assistant stream presentation. The plugin currently consumes the older `session/event`/`inspect` projection seam rather than the newer Remote `page`/`follow` surface. | Treat as a compatibility risk requiring a real Host smoke test, not as a confirmed wire break. Keep the phone protocol independent of DSH controller shapes. |

Official comparison: <https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.7-rc.1...dsh-v0.1.7-rc.2>.

## New rc.2 capabilities worth using

Prioritized for DeepPilot, in this order:

1. **Durable reminders and schedules (highest value).** DSH now has
   `schedule_create`, `schedule_list`, `schedule_delete`, and
   `schedule_update`, persistent one-shot/fixed-rate/daily/weekly/cron tasks,
   restart survival, delivery history, and a minimum one-minute interval. Add
   an optional, session-bound schedule surface to the phone: list tasks, create
   or edit a task, delete it, and show delivery history. Keep all operations
   behind `sessions.manage` plus a dedicated schedule scope; never log reminder
   prompts. A reminder must remain bound to its original Host Session.
   *(Implemented in 0.8.3. As of DSH 0.2.0 this capability is no longer
   bundled by default — see "Automation is now an optional bundle" above, and
   any real-host verification must enable Automation tasks first.)*
2. **Host Session search.** `sessionController.search(query)` returns bounded
   snippets without activating an Agent. This maps naturally to a phone search
   screen and can reduce the amount of history transferred over a mobile link.
   Return only the bounded snippet/session identity and keep it in the
   `sessions.read` authorization domain.
3. **Conversation forking.** `sessionController.fork({ sessionId, atSeq? })`
   enables a phone action such as “branch from this turn”. It is additive to
   the phone protocol but needs an iOS mirror, cursor/ownership tests, and a
   deliberate policy for subagent and archived Sessions.
4. **Queue editing.** `sessionController.updateQueue` supports editing,
   removing, or steering a pending queue item. This is useful for a phone when
   a turn is already running, but it needs first-class queue UI and conflict
   handling rather than silently changing the existing prompt path.
5. **Open/reveal on the Mac.** rc.2 adds verified native workspace-path opening
   and application discovery. This could power a deliberate “Reveal in Finder /
   Open associated app” action. Keep the Host's path verification and show an
   explicit confirmation on the phone; do not expose arbitrary shell access.

Features that are primarily Web/Desktop UX (onboarding, keyboard shortcut
management, archived-only filters, account/API-key model entry separation, and
background continuation) should not be copied into the phone plugin unless
they solve a mobile-specific need.

## Required rc.2 upgrade gate

> Superseded by the 2026-09-28 `0.2.0-rc.1` audit at the top of this file. The
> gate below still applies to that release with one change: a schedule smoke
> test additionally requires the user to enable the **Automation tasks** bundle,
> because a stock 0.2.0 Host does not mount the Schedule service.

Do not call the rc.2 baseline fully supported until all of these are true:

1. The exact DSH peer/dev pins and lockfile remain on `0.1.7-rc.2`.
2. The plugin's full release checklist passes: `npm ci`, `npm test`,
   `npm run typecheck`, `npm run build`, `npm run check:config-schema`, Go helper
   tests, and the binary checksum verification.
3. A real DSH rc.2 `web` profile smoke test covers: session list/open, history,
   prompt, model selection, workspace list/create/archive/unarchive, approval,
   question, and disconnect/reconnect replay.
4. A phone-visible schedule create/list/update/delete/history flow is tested
   after the schedule surface is implemented; a passing plugin build alone does
   not prove mobile protocol compatibility.
5. Fork is tested for exact event-prefix behavior, idempotent retries, and
   original-session immutability after the fork surface is implemented.
6. `COMPATIBILITY.md`, README compatibility text, generated `lib/`, and this
   file are updated with the tested DSH version and intentional support range.

## Re-audit rule

For every future DSH release, compare the new tag against the last audited tag,
inspect the package/service surfaces actually imported by this repository,
classify install/runtime/protocol risk separately, and append a dated decision
here. Do not treat a release-note summary as proof of compatibility.
