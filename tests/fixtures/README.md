# Cross-client protocol fixtures

The JSON files in this directory are the shared test data for the DeepPilot
Bridge Protocol. Every implementation tests against the same bytes, so the
plugin and the clients cannot drift apart without a failing test.

| File | Pins | Tested by |
| --- | --- | --- |
| `auth-vectors.json` | The `c2s.auth.prove` canonical string and signature encoding (PROTOCOL.md §2.2), signed independently by Node and CryptoKit | plugin, iOS, Android |
| `session-goal.json` | The session goal model in each phase | plugin, iOS, relay |
| `live-activity-goal-phases.json` | The goal phase table for Live Activity updates | plugin, iOS, relay |

## Rules

- **This repository is the only place these files are edited.** The clients
  keep vendored copies and never change them by hand.
- Each client has a drift test that compares its copy with this directory and
  fails while the copy is stale. It runs when a checkout of this repository is
  available next to the client's (or at `DSH_DEEPPILOT_DIR`).
- After changing a fixture here, run `scripts/sync-protocol-fixtures.sh` in each
  client checkout and commit the refreshed copies there.
- `auth-vectors.json` is generated: regenerate it with
  `npx tsx scripts/gen-auth-vectors.mts` rather than editing it.
- Fixtures must not contain real pairing tokens, device tokens, host names or
  message bodies (see CONTRIBUTING.md).

## Where the copies live

- iOS app and relay: `protocol-fixtures/` at the repository root.
- Android app ([Mars-Sea/deeppilot-android](https://github.com/Mars-Sea/deeppilot-android)):
  `core/src/test/resources/protocol-fixtures/`. It vendors only the fixtures
  for features it implements.
