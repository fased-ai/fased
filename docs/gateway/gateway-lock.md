---
summary: "Gateway singleton guard using the WebSocket listener bind"
read_when:
  - Running or debugging the gateway process
  - Investigating single-instance enforcement
title: "Gateway Lock"
---

# Gateway lock

Last updated: 2025-12-11

## Why

- Ensure only one gateway instance runs per base port on the same host.
  Additional gateways must use isolated profiles and unique ports.
- Survive crashes/SIGKILL without leaving stale lock files.
- Fail fast with a clear error when the control port is already occupied.

## Mechanism

- The gateway binds the WebSocket listener immediately on startup using an
  exclusive TCP listener. Default: `ws://127.0.0.1:18789`.
- If the bind fails with `EADDRINUSE`, startup throws:
  `GatewayLockError("another gateway instance is already listening...")`.
- The OS releases the listener automatically on any process exit, including
  crashes and SIGKILL. No separate lock file or cleanup step is needed.
- On shutdown, the gateway closes the WebSocket server and underlying HTTP
  server to free the port promptly.

## Error surface

- If another process holds the port, startup throws:
  `GatewayLockError("another gateway instance is already listening...")`.
- Other bind failures surface as:
  `GatewayLockError("failed to bind gateway socket on ...")`.

## Operational notes

- If the port is occupied by _another_ process, the error is the same. Free the
  port or choose another with `fased gateway --port <port>`.
- Local profile usually means one foreground gateway per shell or desktop session.
- Hosting profile usually means one supervised daemon per host profile. Restart
  that service instead of spawning a second process on the same port.
- Default posture is still `gateway.bind: "loopback"` with remote access layered
  above it through Tailscale Serve, a tailnet bind, SSH, or a trusted proxy when
  needed.
- The macOS app still maintains its own lightweight PID guard before spawning
  the gateway. The runtime lock is enforced by the WebSocket bind.
