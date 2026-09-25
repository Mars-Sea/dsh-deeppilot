---
name: dsh-release-audit
description: Audit DeepSeek Harness releases for the dsh-deeppilot plugin. Use when a DSH version changes, when checking plugin compatibility, or when looking for new DSH capabilities that could become safe DeepPilot features.
---

# DSH release audit for DeepPilot

Use this skill to keep the public `dsh-deeppilot` plugin aligned with DeepSeek
Harness without repeatedly rediscovering the compatibility rules.

## Source of truth

Read these files before making a compatibility decision:

- `docs/DSH_RELEASE_MEMORY.md` — the last audited release, risk decisions,
  feature opportunities, and the re-audit rule;
- `COMPATIBILITY.md` — the currently supported DSH baseline and validation
  limitations;
- `AGENTS.md` — repository contracts and validation requirements;
- `package.json` and `package-lock.json` — the exact DSH peer/development pins.

Treat the official DSH release page and tagged source as evidence, not the
release-note summary alone.

## Audit workflow

1. Identify the new DSH tag and the last audited tag. Fetch the official
   release page and the complete tag-to-tag comparison.
2. Read this repository's `package.json`, lockfile, compatibility assertions,
   and DSH adapter source. Identify the exact Host services, Events, Remote
   methods, Gateway carriers, and Client bundles that the plugin imports.
3. Inspect the corresponding tagged DSH source for each used surface. Check
   method presence, argument/result shapes, stream envelopes, lifecycle
   behavior, and package version constraints.
4. Classify the result separately as:
   - **install/deployment**: package metadata, peer constraints, loader and
     profile compatibility;
   - **runtime**: Host service, Gateway, Cordis lifecycle, and event behavior;
   - **phone protocol**: DeepPilot `PROTOCOL.md` v2, iOS mirror, pairing,
     replay, and authorization boundaries.
5. Identify new capabilities. For each candidate, state the user value, the
   DSH API it would use, the required DeepPilot protocol/UI work, the
   authorization scope, and the tests needed before shipping it.
6. Update `docs/DSH_RELEASE_MEMORY.md` with the tag, date, evidence links,
   decision, risks, feature backlog, and upgrade gate. Update
   `COMPATIBILITY.md` when the supported baseline changes.
7. Never claim a release is supported until the dependency pins, generated
   output, automated checks, and a real DSH Host smoke test have passed.

## DeepPilot-specific rules

- Keep `/phone` and `/phone/health` compatible with the current iOS app.
- Treat `PROTOCOL.md` as normative. Any phone wire change must update the
  TypeScript mirror and coordinate with the private iOS repository.
- Protocol v2 is the current baseline. New optional capabilities should be
  capability-gated; do not silently change existing frame meanings.
- A DSH controller change belongs behind the stable `ApiProxyLike` boundary;
  do not leak DSH controller shapes into the phone protocol.
- Reminder prompts, message bodies, pairing tokens, APNs tokens, relay
  credentials, and tool arguments must not be written to logs.
- New file-open or shell-like behavior must use DSH's verified Host path seam
  and explicit user confirmation. Never add arbitrary remote command execution.
- Scheduled tasks must remain bound to their original DSH Session and use a
  dedicated authorization scope when exposed to phones.

## Required validation

For documentation-only audits, run `git diff --check` and verify every link.
For an actual DSH dependency upgrade, run the repository's full release
checklist, including tests, typecheck, build, config schema projection, Go
helper tests, and binary checksums. Add a real DSH `web` profile smoke test for
sessions, history, prompts, models, workspaces, approvals, questions, replay,
and any newly exposed capability.

## Output format

When reporting an audit, lead with one of these verdicts:

- **compatible** — tested and ready to support;
- **source-compatible, upgrade required** — no code break found, but pins or
  validation still block release;
- **runtime risk** — a used service or event needs an integration change;
- **protocol impact** — DeepPilot/iOS wire coordination is required;
- **unsupported** — a confirmed incompatibility remains.

Never turn a source-level review into a false claim of runtime or iPhone
compatibility.
