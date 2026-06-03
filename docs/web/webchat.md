---
summary: "Browser Chat and native WebChat Gateway WebSocket usage"
read_when:
  - Debugging or configuring WebChat access
title: "WebChat"
---

# Chat and WebChat

The browser **Chat** page at `/chat` and the native macOS/iOS WebChat clients
talk directly to the Gateway WebSocket.

## What it is

- A live chat UI for the selected Agent and session.
- Uses the same sessions and routing rules as other channels.
- Deterministic routing: replies go back to the active browser/native chat
  session, not to a channel route.
- Browser Chat is the normal local operator chat surface.
- Native WebChat clients do not need a separate local static server.

## Quick start

1. Start the gateway.
2. Open **Chat** in the Control UI or the native WebChat UI.
3. Ensure gateway auth is configured (required by default, even on loopback).

## How it works (behavior)

- The UI connects to the Gateway WebSocket and uses `chat.history`, `chat.send`, and `chat.inject`.
- `chat.history` is bounded for stability: Gateway may truncate long text fields, omit heavy metadata, and replace oversized entries with `[chat.history omitted: message too large]`.
- `chat.inject` appends an assistant note directly to the transcript and broadcasts it to the UI (no agent run).
- Aborted runs can keep partial assistant output visible in the UI.
- Gateway persists aborted partial assistant text into transcript history when buffered output exists, and marks those entries with abort metadata.
- History is always fetched from the gateway (no local file watching).
- If the gateway is unreachable, existing screen state may remain visible, but
  sending and refresh actions wait for reconnect.

## Agent tools panel

- **Agent > Tools** fetches a runtime catalog via `tools.catalog` and labels each
  tool as `core` or `plugin:<id>` (plus `optional` for optional plugin tools).
- If `tools.catalog` is unavailable, the panel falls back to a built-in static list.
- The panel edits per-Agent tool policy. Effective runtime access still follows
  policy precedence, service credentials, extension runtime state, and the
  current session's available tool catalog.
- The **Available right now** section is live-session data. If the runtime or
  extension catalog is not loaded yet, the saved policy can still show allowed
  tools while available-now reports a runtime/catalog error.

## Remote use

- Remote mode tunnels the gateway WebSocket over SSH/Tailscale.
- You do not need to run a separate WebChat server.

## Configuration reference (WebChat)

Full configuration: [Configuration](/gateway/configuration)

Channel options:

- No dedicated `webchat.*` block. WebChat uses the gateway endpoint + auth settings below.

Related global options:

- `gateway.port`, `gateway.bind`: WebSocket host/port.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: WebSocket auth (token/password).
- `gateway.auth.mode: "trusted-proxy"`: reverse-proxy auth for browser clients (see [Trusted Proxy Auth](/gateway/trusted-proxy-auth)).
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: remote gateway target.
- `sessions.*`: session storage and main key defaults where configured.
