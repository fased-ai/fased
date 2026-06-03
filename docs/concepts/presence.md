---
summary: "How gateway and client presence entries are produced, merged, and displayed."
read_when:
  - Debugging Advanced instance/client diagnostics
  - Investigating duplicate or stale instance rows
  - Changing gateway WS connect or system-event beacons
title: "Presence"
---

# Presence

Fased presence is a lightweight, best-effort view of:

- the **Gateway** itself, and
- **clients connected to the Gateway** (mac app, WebChat, CLI, etc.)

Presence is used primarily for operator/admin visibility: the Dashboard may show
compact live status, while detailed instance/client rows belong under Advanced
diagnostics or native app debug views.

## Presence fields (what shows up)

Presence entries are structured objects with fields like:

- `instanceId`: stable client identity when the client provides one
- `deviceId`: signed device identity when device auth is present
- `host`: human-friendly host name
- `ip`: best-effort IP address
- `version`: client version string
- `platform`: platform string
- `deviceFamily` / `modelIdentifier`: hardware hints
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`: seconds since last user input, if known
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- `roles` / `scopes`: Gateway role and scope hints from the connection
- `text`: original presence text or generated fallback text
- `ts`: last update timestamp (ms since epoch)

## Producers (where presence comes from)

Presence entries are produced by multiple sources and **merged**.

### 1) Gateway self entry

The Gateway always seeds a `self` entry at startup so UIs show the gateway host
even before any clients connect.

### 2) WebSocket connect

Every WebSocket client begins with a `connect` request. On successful handshake
the Gateway upserts a presence entry for that connection.

#### Why one-off CLI commands don't show up

The CLI often connects for short, one-off commands. To avoid spamming the
Instances list, `client.mode === "cli"` is **not** turned into a presence entry.

### 3) `system-event` beacons

Clients can send richer periodic beacons via the `system-event` method. The mac
app uses this to report host name, IP, platform details, and
`lastInputSeconds`.

Non-node `system-event` text is also added to the system event feed. `Node:`
presence lines are deduped so only meaningful context changes create a system
event.

### 4) Node connects (role: node)

When a node connects over the Gateway WebSocket with `role: node`, the Gateway
upserts a presence entry with `roles: ["node"]` and the granted scopes.

## Merge + dedupe rules (why `instanceId` matters)

Presence entries are stored in a single in-memory map:

- Entries are keyed by a **presence key**.
- Keys are case-insensitive.
- WebSocket connect entries prefer `device.id`, then `client.instanceId`, then
  the connection id.
- `system-event` entries prefer `deviceId`, then `instanceId`, then parsed
  host/IP/text fallback data.

If a client reconnects without a stable device or instance identity, it may show
up as a duplicate row until the old entry expires.

## TTL and bounded size

Presence is intentionally ephemeral:

- **TTL:** entries older than 5 minutes are pruned
- **Max entries:** 200 (oldest dropped first)

This keeps the list fresh and avoids unbounded memory growth.

Disconnects update the entry reason to `disconnect`; they do not immediately
delete the row. The TTL removes stale rows.

## Remote/tunnel caveat (loopback IPs)

When a client connects over an SSH tunnel or local port forward, the Gateway may
see the remote address as `127.0.0.1`. To avoid overwriting a good client-reported
IP, loopback remote addresses are ignored.

## Consumers

### Advanced and native debug views

Advanced/native debug views render the output of `system-presence` and apply a
small status indicator (Active/Idle/Stale) based on the age of the last update.

## Debugging tips

- To see the raw list, call `system-presence` against the Gateway.
- If you see duplicates:
  - confirm clients send a stable `client.instanceId` or signed `device.id` in the handshake
  - confirm periodic beacons use the same `deviceId` or `instanceId`
  - check whether the connection-derived entry fell back to a connection id
