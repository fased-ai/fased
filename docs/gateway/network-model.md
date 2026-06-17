---
summary: "How the gateway, nodes, tailnet access, and canvas host connect."
read_when:
  - You want a concise view of the Gateway networking model
title: "Network model"
---

Most operations flow through the gateway (`fased gateway`), a single long-running
process that owns channel connections and the WebSocket control plane.

## Core rules

- One gateway per host is the normal setup. A gateway owns its configured
  channel sessions and WebSocket control plane.
- For rescue bots or strict isolation, run multiple gateways with separate
  profiles, state dirs, channel accounts, and ports. See
  [Multiple gateways](/gateway/multiple-gateways).
- Loopback first: the gateway WS defaults to `ws://127.0.0.1:18789`. The wizard
  generates a gateway token by default, even for loopback.
- For tailnet access, use either Tailscale Serve on top of loopback or an
  explicit tailnet bind with auth.
- Nodes connect to the gateway WS over LAN, tailnet, or SSH as needed. The
  legacy TCP bridge is kept only for older node integrations.
- Canvas host is served by the gateway HTTP server on the **same port** as the
  gateway (default `18789`):
  - `/__fased__/canvas/`
  - `/__fased__/a2ui/`
- When `gateway.auth` is configured and the gateway binds beyond loopback,
  canvas routes are protected by gateway auth.
- Node clients use node-scoped capability URLs tied to their active WS session.
  See [Gateway configuration](/gateway/configuration) (`canvasHost`, `gateway`).
- Remote use is typically SSH tunneling or Tailscale. See [Remote access](/gateway/remote) and [Discovery](/gateway/discovery).
