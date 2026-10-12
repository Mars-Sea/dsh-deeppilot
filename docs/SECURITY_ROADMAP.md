# Protocol-v2 security status

[简体中文](./SECURITY_ROADMAP.zh-CN.md)

Status: implemented on the development branch. `PROTOCOL.md` is normative. Protocol v1 is not retained; all devices must pair again.

## Implemented

- five-minute, single-use, high-entropy pairing codes;
- P-256 device identities, Secure Enclave on physical iOS devices with a simulator Keychain fallback;
- per-connection nonce/audience/timestamp challenge signatures;
- host-side public-key fingerprints, per-device scopes and immediate revocation;
- anonymous-endpoint rate limits, source blocking, bounded unauthenticated concurrency, and a bounded registry;
- minimal unauthenticated health response; no Bearer or URL credentials;
- privacy-preserving audit identifiers, a global connection switch, and per-device deletion; scopes remain enforced at the protocol layer.

- shared canonical/signature vectors (`tests/fixtures/auth-vectors.json`) read by both the TypeScript tests and the iOS tests, with signatures from Node and from CryptoKit;
- abuse tests for malformed requests, connection churn, replay, expired and altered challenges, and many-source pressure (`tests/auth-hardening.test.ts`);
- documented local recovery when `devices-v2.json` is lost ([DEVICE_REGISTRY_RECOVERY.md](./DEVICE_REGISTRY_RECOVERY.md)).

## Decided

- High-impact approval responses do **not** require a fresh local biometric/user-presence confirmation (decided 2026-10-12). Revisit if the threat model changes, for example a phone shared between people.

## Remaining release validation

- exercise pairing, reconnect/resume, and per-device deletion through both real LAN and Funnel paths;
- an authenticated socket still accepts a second `c2s.auth.prove` and answers it with another welcome and resume replay; the gate should answer `E_PROTOCOL` instead (tracked as a `todo` test);
- keep dependency scanning and CodeQL green, then sign and notarize every distributed helper before claiming production readiness.
