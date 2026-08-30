# Privacy and data flow

DeepPilot connects directly to the DSH Host controlled by the user. The plugin does not upload complete conversations to a DeepPilot application server.

## Data stored on the Mac

By default, runtime state is stored under `$DSH_HOME/deeppilot/`:

- `host-id`: a random, non-secret stable audience identifier;
- `devices-v2.json`: paired public keys, fingerprints, scopes, device metadata, revocation/last-seen timestamps, notification preferences, and APNs registrations;
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

## Logs

Routine logs contain lifecycle state, delivery outcomes, and process-local salted hashes for source/device identifiers. Logs are designed not to contain pairing codes, key material, APNs tokens, or message bodies. Frame diagnostics appear only with `debug`.
