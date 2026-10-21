# Compatibility

This branch targets exactly **five DSH releases**: `0.2.0-rc.2`, which the npm
`latest` channel points at; `0.2.1-alpha.3`, `0.2.1-alpha.4`, and
`0.2.1-alpha.5`, which the `alpha` channel has pointed at in turn; and
`0.2.1-rc.2`, which the `next` channel points at. All five are
named in both `engines.dsh` and `peerDependencies`; no other version is accepted.
DSH evaluates that declaration before composing a profile — on every start, not
only on install — so a newly published DSH release deactivates this plugin until
the list is widened deliberately. That is the intended trade: a plugin that
cannot run on an unaudited host fails visibly instead of misbehaving quietly.
The decision and the reversal it represents are recorded in
[`docs/决策记录.md`](./docs/决策记录.md) (章节一), with the supporting audit in
[`docs/DSH_RELEASE_MEMORY.md`](./docs/DSH_RELEASE_MEMORY.md).

The development packages this branch builds and typechecks against stay pinned
to the exact release-candidate baseline, currently `0.2.0-rc.2`; the audited
`alpha` and `rc` hosts are covered by the isolated composes and live runs
recorded in the release memory.

| Component | Current contract | Evidence |
|---|---|---|
| Node.js | 22 or newer | Package engine and CI |
| DSH CLI and Host API | `engines.dsh` and `peerDependencies` both name `0.2.0-rc.2 \|\| 0.2.1-alpha.3 \|\| 0.2.1-alpha.4 \|\| 0.2.1-alpha.5 \|\| 0.2.1-rc.2` (dev pins `0.2.0-rc.2`) | Peer metadata, source typecheck, unit tests, bundle build, and config schema projection against a real 0.2.0-rc.2 CLI, plus isolated composes and live phone-protocol runs with the published 0.2.1-alpha.2, 0.2.1-alpha.3, and 0.2.1-alpha.4 CLIs, an isolated 0.2.1-alpha.5 host where this plugin now composes, starts, and answers `/phone/health` with 200 on its own LAN listener, and a pre-widening 0.2.1-rc.2 host run where the unchanged declaration is refused at compose time (audits below) |
| iOS bridge | DeepPilot protocol v2 | Bridge protocol tests; device behavior must be checked with the running Host and app |
| Remote access | Tailscale Funnel on ports 443, 8443, or 10000 | Helper and supervisor tests |
| Funnel helper platforms | macOS 13 Ventura or later, Linux, and Windows, each on amd64/arm64; built with Go 1.27, which dropped macOS 12 | CI starts the committed helper on a native runner for each of the six targets (`helper-smoke`); no runner covers macOS 13 itself |

## DSH interfaces used here

- The Host adapter uses Session and Workspace controllers, Gateway Remote Events, and `typertGateway.wireStream.open(endpoint, payload, uplink, peer, signal)`. Its in-process carrier passes `undefined` for `uplink`, a live owner/answer Peer for `peer`, and the cancellation signal in argument five. That Peer comes from `connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })` where the Host exposes it, and from the `connection.operator` instance otherwise. The same Peer is named on `fetchHandler.fetch(request, peer)` and the Connection install goes through `installConnection(ctx, { transport, interactions: 'answer' })` when the Client face offers it. alpha.3 requires all three; alpha.2 ignores the extra `fetch` argument, defaults an absent `open` peer to its operator, and ignores the participation.
- The resident Client sends relative RPC paths such as `api/$events/result`. The in-process transport resolves those paths to a local URL before constructing a Node `Request`; the shared Fetch handler dispatches it without a network request. This is required for iOS approval and question answers to settle at the Gateway.
- The client settings page binds `configForms.get('deeppilot')` when the service becomes available. The Host reads volatile config references from its profile entry and reconciles transports on `loader/volatile-update`.
- Typert strict codecs publish `create()` factories. Session opening reads `session.projections` for a complete baseline; that controller requires a cancellation signal from `0.2.1-alpha.2` on, so the adapter always passes one.
- The Host adapter retains a stable bridge-facing API so the phone protocol does not depend directly on DSH controller shapes. This adapter is an internal design boundary, not support for an older DSH Host.

## Separate protocol and data boundaries

- Protocol v2 is the only supported phone wire version. Protocol-v1 devices must pair again. The LAN listener uses its own TLS identity and certificate pinning; old LAN pairings without a fingerprint must also pair again.
- The current app accepts the `deeppilot://pair` link and the JSON pairing payload. Bearer authentication, URL credentials, and first-frame shared tokens are rejected; devices register a P-256 public key and sign each WebSocket challenge.
- The plugin's persisted device and Funnel state migration remains separate from DSH API version support. Session logs written by earlier DSH builds are readable only when the current Host's own history reader accepts them; this plugin does not rewrite those logs.
- An unavailable optional OS facility, transport, or controller disables its dependent capability without crashing the Host.

## Schedules ship with the Web composition

Reminders need no user action on a current host. DSH 0.2.0 briefly moved
automation out of the shipped Web composition into the optional
`@deepseek-ai/dsh-experimental-schedule-bundle`, and the following release
removed that bundle again: it is listed in `RETIRED_BUNDLES`,
`@deepseek-ai/dsh-web-app` mounts `schedule` and `ui-schedule` in every Web
profile, and loading a profile strips the retired entry from
`dsh.profile.bundles`. The plugin manager no longer shows an **Automation
tasks** switch, so no profile is expected to enable anything for reminders.

The plugin needed no change for either step. It resolves the service through
`ctx.get('schedule')`, never declares `schedule` in `inject`, and reports
`welcome.capabilities.schedules = false` with a stable `E_UNSUPPORTED` for every
schedule frame when the service is absent. On a Web host the service is mounted,
so the capability bit is `true` by default; a profile that drops the rows still
reports `false` and still degrades cleanly.

The capability is resolved lazily rather than captured when the bridge is
built. The bridge mounts on `sessionController` / `connection` /
`typertGateway`, all of which become ready before the Schedule service finishes
its own initialization, so a probe taken at that moment would report `false` for
the bridge's whole lifetime. On a live host with the service mounted the bit is
`true` and the schedule list/create/history/delete flow passes.

## Configuration migration

The verbose-diagnostics field moved from the top-level `debug` to
`diagnostics.debug` and gained a settings-page switch. A config file that still
carries the old top-level `debug: true` is accepted but that value is ignored:
verbose logging must be turned on again from the settings page. No other config
field changed shape, and the old key is not read anywhere in this version.

## 0.2.1-rc.2 audit outcome

The artifact-level audit of `dsh-v0.2.1-rc.2` against `dsh-v0.2.1-alpha.5` found
no change that reaches this plugin's call surface. Fifteen packages were compared
as whole trees rather than by `lib/` alone: all ten peer packages carry
**byte-identical `lib/` trees**, and across 137 modules **no export symbol is
added or removed**. The 245 dependency differences are spec-value moves only,
with zero structural difference: 78 `@deepseek-ai/dsh*` entries are pinned to
`0.2.1-rc.2`, and five vendor ranges are promoted from prerelease to GA —
`cordis ~4.0.5-alpha.2` → `~4.0.5`, `schemastery ~3.18.5-alpha.2` → `~3.18.5`,
plus `cordis-plugin-include`, `cordis-plugin-loader`, and `cordis-plugin-timer`.
No dependency package name is added or removed.

**One file outside `package.json` differs, and it is additive.**
`@deepseek-ai/dsh-web-app/cordis.patch.yml` gained one hunk / +3−0 that inserts
the `ui-deepseek-model-label-1017` bundle (the DeepSeek-V4.1-Flash-1017
adaptation named in the rc.2 release notes). It cannot reach this plugin: the
patch anchor this plugin targets, `id: directory-picker`, is byte-identical at
lines 113–114 on both sides, the new entry sits at lines 412–417, and the new
package name appears zero times in this plugin's `cordis.patch.yml` and
`package.json`.

That file is also why the audit method changed: **comparing only `lib/` would
have missed it**, and it is exactly the surface this plugin's own patch layer
acts on. Whole-tree comparison is now a required step of every future audit, not
a fallback.

The vendor peers need no widening either. `0.2.1-rc.2` vendors the same GA pair
as `0.2.1-alpha.5` — `cordis 4.0.5` and `schemastery 3.18.5` — and four
independent solver paths (host-tree and repository `semver`, each with and
without `includePrerelease`) agree that both already satisfy the existing
`~4.0.4 || ~4.0.5-alpha.1` / `~3.18.4 || ~3.18.5-alpha.1` ranges.

The activation verdict is the same shape as alpha.5: rc.2 resolves the
requirements path from a declared `engines.dsh` alone, so its refusal names that
single requirement rather than the ten peers, and `exempted` is false because no
profile exemption file exists on the audit machine. Before the widening, a real
rc.2 CLI refused the unchanged declaration —

```text
dsh: skipping profile bundle "dsh-deeppilot": … Plugin dsh-deeppilot@0.9.7 is incompatible with dsh 0.2.1-rc.2: requirements {"engines.dsh":"0.2.0-rc.2 || 0.2.1-alpha.3 || 0.2.1-alpha.4 || 0.2.1-alpha.5"}. … Exact-version exemption: not active.
```

— while the host itself still booted and served its web port. Three published
evaluators agree on all 14 candidates, and the widened declaration admits
`0.2.1-rc.2` while adding no other acceptance. **`0.2.1-rc.1` is deliberately not
added and remains refused**: the rc line reached this plugin one release later, so
admitting the earlier rc would extend support to a host that was never audited as
its own. `0.2.1-alpha.1`, `0.2.1-alpha.2`, `0.2.0-rc.1`, `0.2.0`, `0.2.1`,
`0.2.1-rc.3`, `0.3.0-rc.1`, `0.3.0`, `1.0.0`, and `0.1.7-rc.2` remain refused.

**Audit limits, stated rather than implied.** Loading this plugin on a real
isolated `0.2.1-rc.2` host — the positive half of the rc.2 verification — had
**not** been completed when this entry was written; the rc.2 evidence here is the
pre-widening refusal log plus the published evaluators' verdict on the widened
declaration. Until the positive load and the full release check set run against
that host, this release is recorded as audited at the declaration and
artifact-diff level only; no plugin release has been made from this tree, and
nothing here claims one.

## 0.2.1-alpha.5 audit outcome

The source-level audit of `dsh-v0.2.1-alpha.5` against `dsh-v0.2.1-alpha.4` found
no runtime break. Of the ten peer packages, **nine have byte-identical `lib/`
trees** — including `dsh-api-gateway` and the three Client faces the resident
interaction client loads — so every alpha.3 fix still holds unchanged. Only
`dsh-api-remotes/lib/client.js` differs: three hunks / 36 lines, all inside the
`account/getUnnotifiedBonuses` result schema, where the new optional `title`
field arrives while `campaign`, `amount`, `currency`, and `grantedAt` become
optional and are forwarded without validation. The file's exported symbols are
identical, and this plugin does not consume that endpoint, so the change is
additive from here.

The vendor peers need no widening either: both hosts' vendor pins moved from
prerelease to GA — `cordis 4.0.5-alpha.2` → `4.0.5` and `schemastery
3.18.5-alpha.2` → `3.18.5` — and both GA releases already satisfy the existing
`~4.0.5-alpha.1` / `~3.18.5-alpha.1` ranges.

The activation verdict is the same shape as alpha.4, with one difference: alpha.5
resolves the requirements path from a declared `engines.dsh` alone, so its
refusal names that single requirement rather than the ten peers. Adding
`0.2.1-alpha.5` to the closed list therefore makes it activate, and the four
audited hosts pass while `0.2.1-alpha.1`, `0.2.1-alpha.2`, `0.2.0-rc.1`, `0.2.0`,
`0.2.1-rc.1`, `0.2.1`, `0.3.0-rc.1`, `0.3.0`, `1.0.0`, and `0.1.7-rc.2` remain
refused.

**Audit limits, stated rather than implied.** Loading this plugin on a real
isolated `0.2.1-alpha.5` host, and the full release check set (unit tests,
typecheck, build, config-schema check, helper tests) against that host, had
**not** been completed when this entry was written. Until they are, this release
is recorded as audited at the declaration and source-diff level only; no plugin
release has been made from this tree, and nothing here claims one.

## 0.2.1-alpha.4 audit outcome

The source-level audit of `dsh-v0.2.1-alpha.4` against `dsh-v0.2.1-alpha.3` found
no runtime break and one deliberate activation break. Of the ten peer packages,
**eight have byte-identical `lib/` trees** — including `dsh-api-gateway` and the
three Client faces the resident interaction client loads — so every alpha.3 fix
still holds unchanged. Only `dsh-api-remotes` changed in code: one additive
Remote Events entry (`plugin-market/changed`) and the rename of
`IncompatiblePlugin.peers` to `requirements`, a field this plugin never reads.
Two packages appear for the first time — `dsh-plugin-market` and
`dsh-experimental-plugin-market-bundle` — behind the release's custom plugin
index sources; neither is a dependency of this plugin.

The activation break is the release's own stated migration: DSH now evaluates a
plugin's `engines.dsh` range **alone**, ignoring `peerDependencies` entirely
whenever that field is present. A package that declares no `engines.dsh` — as
this one did — keeps the older peer evaluation, so the previously exact peer
list rejected `0.2.1-alpha.4` and the plugin would not have activated on it.
Both declarations were widened from the previous three-release list to the same
four releases. The audit reproduced that refusal against the published
`evaluatePluginCompatibility` of both hosts before changing anything, and the
same harness confirms the four audited hosts pass while `0.2.1-alpha.2`,
`0.2.1`, and `0.3.0` still fail.

Nothing else moved. Protocol v2, pairing state, and device records are untouched,
so no paired phone needs to re-pair, and the vendor peers need no widening: both
hosts still vendor `cordis 4.0.5-alpha.2` and `schemastery 3.18.5-alpha.2`, which
the existing ranges already admit.

## 0.2.1-alpha.3 audit outcome

The source-level audit of `dsh-v0.2.1-alpha.3` against `dsh-v0.2.1-alpha.2`
(852 commits, 3311 changed files) found the first release on this line that
breaks the plugin at runtime. One root cause — alpha.3 makes every in-process
carrier name a `PeerScope` with a `principal`, a `signal`, and an `interactions`
participation — landed in four places: `wireStream.open`'s `peer` argument became
required, the `$events` endpoint began requiring `interactions: 'answer'`,
`ConnectionFetchHandler.fetch` gained a required Peer, and the `node` export
condition started resolving the Client faces to bundles that export them as ESM
instead of registering the browser module banner the resident Client's loader
reads. The failure mode was silent: the resident interaction client did not
start, so the phone lost approval and question delivery while every other
capability kept working.

All four are fixed in one call form both hosts accept (see "DSH interfaces used
here"). The peer range was narrowed to name `0.2.0-rc.2` and `0.2.1-alpha.3`
explicitly, and protocol v2, pairing state, and device records are untouched, so
no paired phone needs to re-pair. The live runs behind this verdict are recorded
in [`docs/DSH_RELEASE_MEMORY.md`](./docs/DSH_RELEASE_MEMORY.md): alpha.3 with the
unfixed build logs `DSH Remote interaction client unavailable`, alpha.3 with this
build does not, and alpha.2 still scores the checklist result it did before the
change.

Two host-side migrations in this release belong to the operator rather than to
the plugin: a residual `models` key on an `llm-deepseek-account` entry now fails
that plugin's load, **including an empty array**, and `--from-default-profile`
now replaces an existing profile directory — its `node_modules` and the user's
own `cordis.patch.yml` included — instead of leaving it in place.

## 0.2.1-alpha.2 audit outcome

The source-level audit of `dsh-v0.2.1-alpha.2` against `dsh-v0.2.1-alpha.1`
(669 commits, 3226 changed files) found the peer set almost untouched — 10 of
the 12 peer packages have zero changed source files — but one real break
outside it: `SessionController.projections` now aborts before it reads
anything, so the adapter's signal-less call lost the entire projection baseline.
That is fixed here: `src/dsh-api-proxy.ts` passes a signal, its controller
mirror declares one required, and a regression test fails against the previous
call form. Install and phone-protocol risk are unchanged — the peer range admits
`0.2.1-alpha.2`, and protocol v2, pairing state, and device records are
untouched.

A live `0.2.1-alpha.2` host has now exercised the bridge. An isolated profile
built from the shipped Web template, booted by the published CLI, passed the
phone-protocol checklist over the LAN TLS listener — health, SPKI, pairing
rejection, WSS upgrade, challenge/prove with all six scopes, session and
workspace RPCs, archive/unarchive, the schedule create/history/delete flow, and
reconnect replay (25 pass, 0 fail, 3 skipped). Running the published `0.9.3` on
the same host version instead logged
`[deeppilot] sessions.projections failed: internal` while still passing every
step, which is the silent degradation this release fixes. A real model turn, the
Funnel transport, and a real iPhone are still unverified.

## 0.2.0-rc.2 audit outcome

The source-level audit of `dsh-v0.2.0-rc.2` against `dsh-v0.2.0-rc.1` found no
breaking change in the DSH service surfaces the plugin calls: 9 of the 10 peer
packages are source-identical (only their `package.json` `version` field
changed), `dsh-api-remotes` gained one unrelated remote mount, `api/gateway`
gained an additive `hasLiveClient()` method with the `wireStream.open`
argument order unchanged, and the one `schedule/schedule` source change was an
internal model-framing string with no exported signature change.

Because this audit found the same "additive only" pattern as the two prior
ones, the DSH peer range moved from an exact pin to `>=0.2.0-rc.2 <0.3.0-0`
(see [`AGENTS.md`](./AGENTS.md)): every future `0.2.x` host trusts this audit
history instead of requiring its own `package.json` update before it can
install the plugin. A source diff is still expected for each new DSH release
and recorded in `docs/DSH_RELEASE_MEMORY.md`, but a clean result now only
needs a documentation update, not a peer-range widening.

> **Superseded 2026-10-14.** That open-ended range was narrowed back to the two
> versions actually audited, `0.2.0-rc.2` and `0.2.1-alpha.3`; see the
> 0.2.1-alpha.3 outcome above and `docs/决策记录.md` (章节一). The paragraphs in
> this historical entry describe the policy as it stood on 2026-09-29.
> **This note is in turn superseded:** `0.2.1-alpha.4` was added the next day by
> the same deliberate audit step, `0.2.1-alpha.5` on 2026-10-16, and
> `0.2.1-rc.2` on 2026-10-17 — each one its own audit, never an automatic
> consequence of a new DSH tag. The closed five-release list now lives in
> `engines.dsh` as well as in `peerDependencies`. `0.2.1-rc.1` shows zero code
> delta on this plugin's call surface but is deliberately left out, because it
> was never audited as its own host. See the 0.2.1-rc.2 outcome above.

## 0.2.0-rc.1 audit outcome

The source-level audit of `dsh-v0.2.0-rc.1` against the previous baseline
`dsh-v0.1.7-rc.2` found no breaking change in the DSH service surfaces the
plugin calls. Of the 78 service-surface files compared, 75 are byte-identical
and the three that changed are additive: `fork()` gained an optional
`onCreated` callback, and a `run()` helper call gained an internal `'hidden'`
argument. The `api/gateway` package, including the `wireStream.open` argument
order, is unchanged, as are the Typert protocol exports, `configForms`, and
every `schedule` source file.

The exact 0.2.0-rc.1 package pins, the regenerated registry lockfile (228
packages, all carrying `resolved` and `integrity`), the compatibility
assertions, generated output, unit tests, typecheck, build, Go helper tests,
helper checksums, and a config-schema check against a real 0.2.0-rc.1 CLI all
pass locally. A real 0.2.0-rc.1 `web` profile smoke test also passes: 25 checks,
0 failures, driven by `scripts/smoke-live.mts` in the source repository (it is
a maintainer tool and is not part of the published package) against a booted
profile. Approval and question round trips are the one gap —
the stock profile auto-approves tool calls, so those paths need a profile with
a restrictive tool policy. The planned phone additions for durable schedules
and session forking are specified in
[`docs/DEEPPILOT_FEATURE_PLAN.md`](./docs/DEEPPILOT_FEATURE_PLAN.md); they are
not advertised until the protocol, iOS mirror, and integration tests land.

The complete audit evidence and re-audit procedure remain in [`docs/DSH_RELEASE_MEMORY.md`](./docs/DSH_RELEASE_MEMORY.md).

## Evidence limits

Unit tests and config schema projection do not prove every network, macOS, Linux, Windows, or iPhone combination. In particular, physical-device performance, signed helper distribution, and production APNs delivery need their own checks. Include the exact DSH version, plugin commit, Node version, OS, connection mode, and sanitized status output when reporting a compatibility issue; never include credentials or message content.
