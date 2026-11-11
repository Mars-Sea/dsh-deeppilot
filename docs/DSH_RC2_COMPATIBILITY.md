# DSH 0.2.2-rc.2 compatibility audit

Date: 2026-11-11 (Asia/Shanghai). Plugin: `dsh-deeppilot` 0.9.20 working tree. Baseline: DSH 0.2.2-rc.1. This is a source and offline-test audit, not a published-package or live-phone acceptance result.

## Verdict

The current rolling declaration admits rc.2 without changes. The audited transport and frontend integration interfaces retain the forms DeepPilot uses. The two identified projection defects have now been repaired locally and covered by regression tests: native tool-result pairing/failure state and named message targets. Actual rc.2 distribution and live-phone acceptance remain unverified, so this report does **not** certify unrestricted runtime compatibility.

The repair changes only plugin projection code, tests, generated Host artifacts and these audit records. No app release, bridge protocol bump, dependency declaration, lockfile or public protocol fixture change is required.

## Release identity and availability

- Official release: [dsh-v0.2.2-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2), published 2026-11-11T11:33:06Z (19:33:06 +08:00).
- Tag reported by `git ls-remote`: `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`. The downloaded tag archive declares 0.2.2-rc.2 in `apps/cli/package.json`.
- Baseline source: [dsh-v0.2.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1). [Full upstream comparison](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.2-rc.1...dsh-v0.2.2-rc.2).
- At audit time the npm exact-version endpoints (encoded and unencoded scope) and expected rc.2 tarball returned HTTP 404 from this environment. A full packument request still returned `latest`/`next` = 0.2.2-rc.1 and contained no rc.2. This limits verification of the npm distribution; it does not contradict the GitHub release.
- Installed global CLI remains 0.2.2-rc.1. This audit did not upgrade or restart it.

## Install and activation risk

`package.json` declares `engines.dsh` and ten optional DSH peers as `>=0.2.1-rc.5 <0.3.0-0`. The rc.2 source evaluator (`packages/boot/app-boot/src/plugin-compatibility.ts`) is byte-identical to rc.1 and still evaluates prereleases with `includePrerelease: true`.

The actual rc.2 **source evaluator**, imported through the existing local `tsx` development tool, accepted the current plugin manifest on 0.2.2-rc.2 and refused 0.3.0-rc.1. This is narrower than proving published rc.2 profile composition or activation.

rc.2 source vendors Cordis 4.1.0 and Schemastery 3.19.0; their source is byte-identical to rc.1 and both remain within the plugin's vendor peer ranges. No lower-bound or upper-bound change is warranted by this audit.

npm's ordinary prerelease peer matching can still warn for the rolling DSH peer range; optional peer declarations and the host activation evaluator are separate concerns. No clean rc.2 npm installation was performed.

## Host runtime and browser integration

Direct tag-to-tag file comparisons were made over the surfaces used by the plugin, including request and response fields rather than method names alone.

| Surface | Evidence and assessment |
| --- | --- |
| Connection transport, owner peers, shared fetch and resident Client installer | All 18 source files in `packages/client/connection/src` are identical. Existing `createPeer`, `createSharedFetchHandler`, `fetch(request, peer)`, explicit `installConnection` and in-process stream hooks retain their interfaces. |
| Gateway RPC, wire streams, forwarded Remote event client | All 12 source files in `packages/api/gateway/src` are identical. |
| Typert protocol and registry | All 8 protocol and 4 registry source files are identical. The node/browser `/client` entry selection remains declared for the resident-client loader. |
| API remotes | Adds the `web/providers-changed` emit event and associated type imports; approval and question waterfall subscriptions remain present. |
| Workspace controller and browse directory picker | All 10 workspace-controller source files and the browse-picker source are identical. The Web bundle still declares `id: directory-picker`, which DeepPilot's overlay disables. |
| Session prompt | Adds empty-content continuation of an eligible failed idle session; ordinary nonempty prompts retain the existing request fields. DeepPilot does not expose the new empty-prompt action. |
| Schedule and goals | All 8 schedule and 6 goal source files are identical. Existing host-schedule adaptation and optional goal projection remain applicable. |
| Settings page | Config-form implementation, Button and Switch implementations are identical. The `settings.section` and `settings.section.icon` slots remain. The launcher gains an optional section id; the slot layer adds `hoc` without replacing DeepPilot's list registrations. |
| Shared browser modules | rc.2 continues to seed React and `@deepseek-ai/dsh-client-ui-primitives`, which the built plugin requires. No custom menu-position API is used by DeepPilot's settings page. |
| Plugin updater | The Host adds Git update specifications and replaces its bundle `updatable` boolean with optional `update: 'registry' | 'git'`. DeepPilot's structural interface does not read `updatable`; its update flow uses the retained registry methods. New Git update support is not offered by the phone. |
| Host Web and export transport | Webserver source and export Host source retain the consumed transport/routes; changes to the export package are in its Client UI files. This does not establish proxied rc.2 GUI behavior on a real phone. |

New named/multilevel subagent management and new Web UI features are not automatically new native DeepPilot features. Generic tool/chat projection and stable phone protocol compatibility must be assessed separately from native feature parity.

Upstream also changes archive behavior: eligible Git worktrees may be cleaned up on session archival, retaining branches and commits. DeepPilot invokes the Host's workspace archive operation, so Host configuration governs this behavior. This is an upstream behavior change to consider during acceptance, not a phone decoding failure.

## Reproduced defect: tool-result identity and failure state

**Priority: P1. Existing in rc.1 and reproduced against rc.2; repaired locally on 2026-11-11.** The following describes the pre-fix behavior.

Both tags' Session event declarations put result identity at `data.message.toolCallId`; `tool/call` still uses `data.callId`. Tool failures use `message.isError`, with optional `data.error` metadata. The current bridge instead reads `data.callId` from results and tests only whether `data.error` is defined:

- `src/host-event-projection.ts:112-127`: live `tool.end` projection.
- `src/host-event-projection.ts:820-842`: history pairing and result state.
- Upstream `packages/core/session/src/types.ts`, `tool/result` declaration; rc.1 published declarations agree with the tagged source.

A synthetic, contract-valid failed result with `message.toolCallId: "audit-call"` and `message.isError: true`, without optional error metadata, was passed through the real bridge projection functions. Observed output:

1. Live `tool.end` omits `callId` and sets `ok: true`.
2. History leaves the original named call in `running` state.
3. History adds a separate `result` row marked `ok` containing the failure text.

Successful results also fail identity pairing when only the documented nested id is supplied. Failures that include `data.error` retain an error state, but the identity mismatch remains.

The original reproduction used no live Host, model, user conversations, or external services. Its ignored `.rc2-verify/reproduction.json` preserves pre-fix evidence; the old `.rc2-verify/reproduce.mts` asserts the defect and is not the post-fix validation command.

Applied repair: a shared `toolResultOf` normalizer reads `message.toolCallId` first with the older top-level field as fallback, and recognizes `message.isError` or legacy error metadata. Live events, history and image-reference indexing use the same result. Failed results neither expose image attachments nor enter the image read-back index. `tests/tool-result-compatibility.test.ts` covers success, metadata-free and metadata-bearing failures, older payloads, native-id precedence, orphan results, absent ids, history merging and incremental tail updates. Existing target metadata is preserved when results complete a call. The phone protocol remains v2.

## New rc.2 presentation gap: named message targets

**Priority: P2. New in rc.2; repaired locally on 2026-11-11.** The Host `send_message` tool changes its target argument from `agent_id` to `agent` (`packages/subagent/tool-subagent-control/src/index.ts:48-53,78-80`). Before the repair, DeepPilot's `TEXT_TARGET_KEYS.send_message` recognized only `target` and `agent_id`, so `toolTargetOf` returned `undefined` for `{ agent: "reviewer", message: "hello" }`. Host-owned message execution was unaffected. The applied repair recognizes `agent` first and retains `target` and `agent_id` as fallbacks. `tests/tool-target-projection.test.ts` checks all three forms, native-field precedence, live projection and target preservation after result merging.

Independent runtime review also confirmed that Session batch append still emits `session/event(session, event)` once per member, in order, after committing the batch; DeepPilot does not need an array-based listener. The quiet-completion hooks remain applicable. New tool failure names/codes are result metadata rather than controller RemoteError codes, so they do not by themselves require new `wire-errors.ts` mappings.

## Phone protocol and relay

Both mobile clients use DeepPilot Bridge Protocol v2 and the `/phone`, `/phone/pair`, `/phone/health` endpoints. They do not invoke the DSH Gateway directly, and neither adds a DSH semver activation gate. Their acceptance of additive capability fields isolates them from the audited Host API additions.

All four vendored fixture copies matched the canonical plugin bytes: three iOS/relay fixtures (authentication vectors, session goal, Live Activity goal phases) and Android authentication vectors. Android intentionally does not vendor goal fixtures; equality is not evidence of Android goal feature parity or a complete protocol-schema check.

The clients retain some semantic coupling, including exact command definition ids such as `@deepseek-ai/dsh-permission-presets`, `@` reference syntax and tool argument presentation. A stable JSON envelope alone cannot guarantee every native action remains equivalent. No public protocol change was identified or made by this audit.

## Checks performed

| Check | Result and scope |
| --- | --- |
| Plugin `npm test` | 830 tests: 828 pass, 0 fail, 1 skip, 1 existing TODO. The TODO logs a failed assertion about replayed authentication proofs but is not a new failing test. These tests use the existing baseline/mocks, not a live rc.2 Host. |
| Plugin `npm run typecheck` | Passed against existing pinned baseline development packages. |
| Plugin `npm run build` | Passed; client runtime requires verified. Generated tracked artifacts did not change. Existing build warnings concern browser CJS targeting and the experimental TypeScript 7 API. |
| rc.2 source evaluator | Current manifest accepted at rc.2; next minor prerelease refused. |
| Pre-fix tool-result reproduction | Confirmed incorrect live/history projection for a valid Host result before repair. |
| Post-fix focused regression suite | 35/35 passed across tool-result compatibility, target projection, history/incremental tail and image-reference indexing. |
| Post-fix full plugin validation | 840 tests: 838 pass, 0 fail, 1 existing skip, 1 existing TODO; typecheck and build passed. Generated Host bundle and source map regenerated; browser bundle and public types unchanged. |
| Relay `npm test` | 53/53 passed, zero skips or failures. |
| Canonical fixture byte comparisons | All four vendored copies matched. |
| Android offline `:core:test` | Did not reach tests: workspace sandbox denied the Gradle cache lock under `~/.gradle`. The registered system JDK is 25.0.3, outside this project's documented Gradle 8.14 range of JDK 17–24. No successful Kotlin test run is claimed. |

No iOS signed build or Swift test run, actual rc.2 package install/profile boot, rc.2 schema dump, real-device pairing, model turn, Funnel recovery, proxied Host GUI, APNs, or Live Activity delivery was performed. Those remain runtime acceptance gaps; baseline unit-test success does not close them.

## Next verification steps

1. Local projection repairs and regression tests are complete; publication and actual rc.2 runtime verification remain separate steps.
2. Once the actual rc.2 distribution is reachable, verify package integrity/versions, isolated profile composition, config schema, `/phone/health`, resident Remote interactions, images, schedules and goals.
3. Use an isolated synthetic session for phone acceptance, including tool completion/failure, history reload, approvals/questions, cancel/queue, image read-back and archive behavior.
4. Run Android tests with JDK 17–24 and an authorized writable Gradle cache. Run relevant iOS protocol and projection tests in the supported Xcode environment before claiming mobile runtime verification.
