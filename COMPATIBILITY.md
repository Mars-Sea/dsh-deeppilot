# Compatibility

This branch targets the **DSH `0.2.x` line, from `0.2.0-rc.2` onward**. The DSH
peer dependencies accept `>=0.2.0-rc.2 <0.3.0-0`: any later `0.2.x` host,
including future release candidates and the eventual `0.2.0` GA, installs
without a plugin update. The development packages this branch builds and
typechecks against are pinned to the exact audited release, currently
`0.2.0-rc.2`. Every `0.1.x` build and any `0.3.0` or later release are outside
this branch's support scope; a `0.3.x` line requires its own audit and its own
range before the plugin will install there.

| Component | Current contract | Evidence |
|---|---|---|
| Node.js | 22 or newer | Package engine and CI |
| DSH CLI and Host API | `>=0.2.0-rc.2 <0.3.0-0` (dev pins `0.2.0-rc.2`; source audits through `0.2.1-alpha.2`) | Peer metadata, source typecheck, unit tests, bundle build, and config schema projection against a real 0.2.0-rc.2 CLI, plus an isolated compose with the published 0.2.1-alpha.2 CLI |
| iOS bridge | DeepPilot protocol v2 | Bridge protocol tests; device behavior must be checked with the running Host and app |
| Remote access | Tailscale Funnel on ports 443, 8443, or 10000 | Helper and supervisor tests |

## DSH interfaces used here

- The Host adapter uses Session and Workspace controllers, Gateway Remote Events, and `typertGateway.wireStream.open(endpoint, payload, uplink, peer, signal)`. Its in-process carrier passes `undefined` for `uplink` and `peer` and the cancellation signal in argument five.
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

Unit tests and config schema projection do not prove every network, Mac, Linux, Windows, or iPhone combination. In particular, physical-device performance, signed helper distribution, and production APNs delivery need their own checks. Include the exact DSH version, plugin commit, Node version, OS, connection mode, and sanitized status output when reporting a compatibility issue; never include credentials or message content.
