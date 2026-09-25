# DSH release compatibility memory

> This is the durable audit record for DeepPilot's public DSH plugin. Re-audit
> the next DSH release instead of assuming that an rc upgrade is runtime-safe.

## Current decision

- **Audited release:** `dsh-v0.1.7-rc.2` (official release page: <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2>).
- **Comparison baseline:** `dsh-v0.1.7-rc.1` (the previous plugin baseline).
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
