---
summary: "Bridge protocol (legacy nodes): TCP JSONL, pairing, scoped RPC"
read_when:
  - Building or debugging node clients (iOS/Android/macOS node mode)
  - Investigating pairing or bridge auth failures
  - Auditing the node surface exposed by the gateway
title: "Bridge Protocol"
---

# Bridge protocol (historical node transport)

The Bridge protocol was a legacy node transport over TCP JSONL. Current Fased
builds no longer ship the TCP bridge listener. New node clients should use the
unified Gateway WebSocket protocol instead.

If you are building an operator or node client, use the
[Gateway protocol](/gateway/protocol).

Legacy `bridge.*` config keys are no longer part of the config schema.

## Why this existed

- **Security boundary**: the bridge exposed a small allowlist instead of the
  full gateway API surface.
- **Pairing + node identity**: node admission was owned by the gateway and tied
  to a per-node token.
- **Discovery UX**: nodes could discover gateways via Bonjour on LAN, or connect
  directly over a tailnet.
- **Loopback WS**: the full WS control plane stayed local unless tunneled via SSH.

## Transport

- TCP, one JSON object per line (JSONL).
- Optional TLS.
- Legacy default listener port was `18790`.

Current builds do not start this listener.

When TLS was enabled, discovery TXT records included `bridgeTls=1` plus
`bridgeTlsSha256` as a non-secret hint. Bonjour/mDNS TXT records are
unauthenticated, so clients could not treat the advertised fingerprint as an
authoritative pin without explicit user intent or another verification path.

## Handshake + pairing

1. Client sends `hello` with node metadata + token (if already paired).
2. If not paired, gateway replies `error` (`NOT_PAIRED`/`UNAUTHORIZED`).
3. Client sends `pair-request`.
4. Gateway waits for approval, then sends `pair-ok` and `hello-ok`.

`hello-ok` returns `serverName` and may include `canvasHostUrl`.

## Frames

Client → Gateway:

- `req` / `res`: scoped gateway RPC (chat, sessions, config, health, voicewake, skills.bins)
- `event`: node signals (voice transcript, agent request, chat subscribe, exec lifecycle)

Gateway → Client:

- `invoke` / `invoke-res`: node commands (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: chat updates for subscribed sessions
- `ping` / `pong`: keepalive

Legacy allowlist enforcement lived in `src/gateway/server-bridge.ts`, which has
been removed.

## Exec lifecycle events

Nodes can emit `exec.finished` or `exec.denied` events to surface system.run activity.
These are mapped to system events in the gateway. (Legacy nodes may still emit `exec.started`.)

Payload fields (all optional unless noted):

- `sessionKey` (required): agent session to receive the system event.
- `runId`: unique exec id for grouping.
- `command`: raw or formatted command string.
- `exitCode`, `timedOut`, `success`, `output`: completion details (finished only).
- `reason`: denial reason (denied only).

## Current replacement

Use the Gateway WebSocket protocol with gateway authentication, device/node
pairing, and node-scoped capabilities. See [Gateway protocol](/gateway/protocol)
and [Gateway pairing](/gateway/pairing).
