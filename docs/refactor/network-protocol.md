---
summary: "Fased Network protocol refactor: Gateway WebSocket roles, device auth, node transport, and approvals"
read_when:
  - Reviewing the unified Gateway protocol work
  - Updating node/operator auth, pairing, scopes, or approval routing
  - Checking the historical Bridge-to-WebSocket migration
title: "Fased Network Protocol Refactor"
---

# Fased Network protocol refactor

This is an engineering refactor note. It is not the public Fased Network product
guide. Public operator docs live in [Fased Network](/start/federation), [Nodes](/nodes),
and [Gateway protocol](/gateway/protocol).

## Current code state

Fased now uses the **Gateway WebSocket** as the single control plane and node
transport:

- operators connect with `role: "operator"` and scoped permissions such as
  `operator.read`, `operator.write`, `operator.admin`, `operator.approvals`, and
  `operator.pairing`
- nodes connect with `role: "node"` and advertise `caps`, `commands`, and
  permissions
- all WebSocket clients receive a `connect.challenge` and sign it with device
  identity metadata unless a documented break-glass path is enabled
- pairing and device tokens are handled by the gateway device-auth flow
- presence groups operator/node roles under stable device identity
- exec approvals are gateway records resolved by operator clients with
  `operator.approvals`

The old TCP JSONL Bridge is now legacy documentation only. Current node clients
should use [Gateway protocol](/gateway/protocol), not Bridge.

## Source of truth

- `docs/gateway/protocol.md`
- `docs/nodes/index.md`
- `src/gateway/server/ws-connection/message-handler.ts`
- `src/gateway/server/ws-connection/connect-policy.ts`
- `src/gateway/method-scopes.ts`
- `src/gateway/server-methods/devices.ts`
- `src/gateway/node-invoke-system-run-approval.ts`
- `src/node-host/runner.ts`

## Delivered goals

- One WebSocket protocol for operator clients and node clients.
- Role clarity: `operator` for control plane, `node` for capability hosts.
- Operator method scope checks.
- Device identity, challenge signing, pairing, role-scoped device tokens, and
  revocation paths.
- Advanced > Nodes as the operator/admin inspection surface.
- Node `system.run` approval records resolved through gateway/operator scope.

## Still open or intentionally limited

- Remote/public transport hardening still depends on gateway deployment mode,
  Tailscale/private access, trusted proxy settings, and public-edge design.
- Media-heavy node commands still need payload/backpressure care.
- Mobile UX polish and cross-device operator prompts can improve, but the
  protocol boundary is already Gateway WS.
- Legacy Bridge docs remain only for historical context and should not be used
  for new clients.

## Security rules

- Discovery is never a trust anchor.
- Device labels/slugs are human labels only; auth uses signed device identity.
- Node capability claims are not blindly trusted; gateway policy and command
  allowlists still gate what a node can expose.
- `gateway.controlUi.dangerouslyDisableDeviceAuth` is break-glass only.
