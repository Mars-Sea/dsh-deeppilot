# Privacy and data flow

DeepPilot connects directly to the DSH Host controlled by the user. The plugin does not upload complete conversations to a DeepPilot application server.

## Data stored on the Mac

By default, runtime state is stored under `$DSH_HOME/deeppilot/`:

- `host-id`: a random, non-secret stable audience identifier;
- `devices-v2.json`: paired public keys, fingerprints, scopes, device metadata, revocation/last-seen timestamps, notification preferences, APNs alert registrations, WidgetKit push registrations (a separate token per device used only for content-free widget refresh invalidations), and at most one Live Activity registration per device (activity identifier, session identifier, APNs Live Activity update token, environment, and expiry);
- `tailscale/`: local state for the optional embedded tsnet node.

The directory is owner-only mode `0700`. The Mac never receives or stores iPhone private signing keys. Pairing codes exist only in plugin memory for up to five minutes and are not written to disk.

The settings report exposes public-key fingerprints, scopes, revocation state, and masked notification diagnostics. It does not expose full APNs tokens, pairing codes, or message bodies.

## Direct session connection

Projects, history, prompts, streaming events, approvals, questions, and model changes travel over the authenticated connection between the iPhone and the user's DSH Host.

- LAN mode is direct HTTP/WebSocket traffic and is not encrypted by the plugin. Use a trusted network.
- Funnel mode uses HTTPS/WSS. The helper forwards only `/phone`, `/phone/pair`, and `/phone/health`.

## Optional offline push

Direct APNs mode sends the device token and notification payload to Apple using user-controlled credentials. Relay mode sends over HTTPS:

- a per-bridge relay authorization token;
- target APNs device token and environment;
- notification identifier, category, session identifier, title, and a short, truncated body.

The relay does not receive complete history, attachments, live token streams, unrelated prompts, pairing codes, device keys, the device registry, or Tailscale state. Disabling offline push removes this path.

## WidgetKit refresh push

The iOS home-screen widget may register a separate WidgetKit push token (iOS 26+). These invalidations are content-free: the APNs payload is fixed to `{ "aps": { "content-changed": true } }` with no session, title, or body fields, so neither Apple nor the relay learns anything about Host activity beyond "something changed, please refetch". The widget then pulls data over its own short-lived, authenticated read-only connection directly to the user's DSH Host. Widget tokens are stored alongside the alert token in `devices-v2.json`, are throttled to at most one invalidation per Host per 30 seconds, expire after 7 days without re-registration, and are deleted when the device is revoked.

## Live Activity push

A Live Activity on the Lock Screen or in the Dynamic Island may register a separate ActivityKit **update** token. Unlike the WidgetKit path, Live Activity updates are **not content-free**: each push carries a bounded progress projection — the session title (up to 100 Unicode code points), the current in-progress or pending todo item's text (up to 160 code points), the todo done/total counts, and a fixed phase value (`running`, `approval`, `question`, `ended`, or `unavailable`). This projection goes to Apple in direct APNs mode and to the relay in relay mode. It never contains conversation history, message bodies, prompt text, attachments, full todo lists, file paths, or model output.

The activity must be started by the user on the iPhone; there is no push-to-start, and the activity opens no network connection of its own. Only one Live Activity registration is kept per device, registrations expire after eight hours, and the registration is deleted on unregister, token rotation, or device revocation. Relay mode carries only this bounded projection and rejects unknown content-state fields, oversized text, invalid counts, stale timestamps, and event/phase mismatches; the updated relay must be deployed before background Live Activity updates work through relay mode. System delivery and refresh budgets still apply, so updates may be coalesced, delayed, or dropped by iOS.

`push.contentMode: generic` applies to alert notifications only. Live Activity content states always carry the bounded title and current-task text described above, because the activity is rendered from this push; do not register a Live Activity on a device whose Lock Screen should never show session text.

## Logs

Routine logs contain lifecycle state, delivery outcomes, and process-local salted hashes for source/device identifiers. Logs are designed not to contain pairing codes, key material, APNs tokens, or message bodies. Frame diagnostics appear only with `debug`.

### Generic offline notifications

Set `push.contentMode` to `generic` in the plugin configuration to replace conversation-derived notification titles and bodies with generic status text **before** either APNs or the Relay receives them. The default is `preview`, preserving short previews. Device tokens, Host audience, session and notification identifiers, and categories are still sent. This option controls offline pushes; local notifications generated by the iOS app from its direct connection are unchanged.

For identity-tracked sends, the Host stores a bounded local delivery journal containing
hashed device/send keys, content fingerprints, session identifiers, timestamps, and
receipts. It does not store prompt bodies or image data in that journal. The iOS app
stores unresolved send IDs, display text and attachment counts in its instance-scoped
SQLite cache; removing that instance removes this outbox with its database.
