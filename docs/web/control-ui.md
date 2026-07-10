---
summary: "Browser-based Control UI for chat, wallets, mining, Fased Network, config, and operations."
read_when:
  - You want to operate the Gateway from a browser
  - You want Tailnet access without SSH tunnels
title: "Control UI"
---

# Control UI (browser)

The Control UI is the browser app served by the Gateway:

- default: `http://<host>:18789/`
- optional prefix: set `gateway.controlUi.basePath` (e.g. `/fased`)

It speaks **directly to the Gateway WebSocket** on the same port.

For first-run product setup after onboarding, see
[Control UI Setup Model](/start/control-ui-setup). The short version:

- `/dash` is the compact widget dashboard.
- `/chat` is the live browser chat surface.
- `/agents` is the normal setup workbench: Setup, Models, Channels, Skills,
  Tools, Memory, Sessions, Services, Tasks, and Files
  for the selected Agent.
- Agent Tasks shows saved work definitions first. Task templates create scheduled
  tasks; workflow/graph templates create review flows; run history is audit, not
  the task itself.
- `/wallet`, `/mining`, `/federation`, and `/marketplace` own their focused workflows.
- `/extensions` owns global plugin lifecycle; chat app account routing still belongs in Agents/Channels.
- `/notifications`, `/usage`, and `/logs` are monitoring pages.
- `/config` is **Advanced**. It now groups raw Config, Debug, and Nodes under one advanced surface.

The older global provider/channel/service/skills/task routes remain routable for
compatibility, deep links, or admin views. They are hidden or demoted from the
primary navigation because normal setup starts from the selected Agent.

For layout, card, modal, tab, helper-icon, and dashboard widget rules, see
[Control UI Design](/design).

## Quick open (local)

If the Gateway is running on the same computer, open:

- [http://localhost:18789/](http://localhost:18789/) (preferred for browser passkeys and other secure-context checks)
- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) if you explicitly want the numeric loopback host

If the page fails to load, start the Gateway first: `fased gateway`.

Auth is supplied during the WebSocket handshake via:

- `connect.params.auth.token`
- `connect.params.auth.password`

`fased dashboard` opens and copies an auth-ready local URL using a fragment token
(`#token=...`). The UI stores the token and removes it from the browser URL after
load. If you open the page manually, paste the onboarding token into Control UI
settings. Passwords are accepted for the session but are not persisted.

## Device pairing (first connection)

When you connect to the Control UI from a new browser or device, the Gateway
requires a **one-time pairing approval** — even if you're on the same Tailnet
with `gateway.auth.allowTailscale: true`. This is a security measure to prevent
unauthorized access.

**What you'll see:** "disconnected (1008): pairing required"

**To approve the device:**

```bash
# List pending requests
fased devices list

# Approve by request ID
fased devices approve <requestId>
```

Once approved, the device is remembered and won't require re-approval unless
you revoke it with `fased devices revoke --device <id> --role <role>`. See
[Devices CLI](/cli/devices) for token rotation and revocation.

**Notes:**

- Local connections (`localhost` / `127.0.0.1`) are auto-approved.
- Remote connections (LAN, Tailnet, etc.) require explicit approval.
- Each browser profile generates a unique device ID, so switching browsers or
  clearing browser data will require re-pairing.

## What it can do

The Control UI operates Fased without requiring a messaging app first.

- **Dashboard**: compact widget board for Agents, Usage, Wallets, Mining, and
  Fased Network state.
- **Chat**: browser chat for the selected Agent/session, with session switching,
  model overrides, stats, task/session panels, and streamed tool cards.
- **Agents**: setup workbench for Models, Channels, Skills, Tools, Memory,
  Sessions, Services, Tasks, and Files.
- **Wallet, Mining, Fased Network, Marketplace**: focused pages for the
  actions and records owned by those domains.
- **Usage, Notifications, Logs**: monitoring and recent activity.
- **Advanced**: Config, Debug, Nodes, exec approvals, raw RPC tools, and
  read-only update status. Run `fased update` from the terminal.

## Tasks and history boundary

**Agent > Tasks is the saved-work control surface; domain pages keep authority.**
Agent > Tasks manages definitions and can open run history. Wallets, Mining,
Marketplace, Channels, and Services still own actions that can sign, mine,
deliver, send externally, or change external state.

- Use **Task** for scheduled work.
- Use **Trigger** for external HTTP entrypoints.
- Use **Workflow** for a multi-step review or procedure.
- Use **Graph** for the visual editor over the same workflow JSON.
- Use **Templates** only as starters for saved definitions.

Saved definitions and run history are intentionally separate. Definitions
describe what can run. History rows record what already happened, group related
records by `correlationId`, and link back to source pages when a domain owns the
action.

Delivery defaults to an announce summary for isolated tasks. Use none for
internal-only runs, or webhook delivery when `delivery.mode = "webhook"` and
`delivery.to` is a valid HTTP(S) webhook URL.

## Chat behavior

- `chat.send` is **non-blocking**. It acks immediately with
  `{ runId, status: "started" }` and the response streams via `chat` events.
- The Control UI subscribes to `sessions.changed` and the selected session's
  `session.message` stream. The Sessions panel and active chat can update
  without manual refresh or polling.
- Re-sending with the same `idempotencyKey` returns `{ status: "in_flight" }`
  while running, and `{ status: "ok" }` after completion.
- `chat.history` responses are size-bounded for UI safety. Gateway may truncate
  long text fields, omit heavy metadata blocks, and replace oversized messages
  with `[chat.history omitted: message too large]`.
- `chat.inject` appends an assistant note to the session transcript and
  broadcasts a `chat` event for UI-only updates. It does not start an agent run
  or channel delivery.
- Stop:
  - Click **Stop** (calls `chat.abort`)
  - Type `/stop` or standalone abort phrases to abort out-of-band, such as
    `stop`, `stop action`, `stop run`, `stop fased`, `please stop`.
  - `chat.abort` supports `{ sessionKey }` (no `runId`) to abort all active runs for that session
- Abort partial retention:
  - When a run is aborted, partial assistant text can still be shown in the UI
  - Gateway persists aborted partial assistant text into transcript history when buffered output exists
  - Persisted entries include abort metadata so transcript consumers can tell abort partials from normal completion output

## Tailnet access (recommended)

### Integrated Tailscale Serve (preferred)

Keep the Gateway on loopback and let Tailscale Serve proxy it with HTTPS:

```bash
fased gateway --tailscale serve
```

Open:

- `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`)

By default, Control UI/WebSocket Serve requests can authenticate via Tailscale identity headers
(`tailscale-user-login`) when `gateway.auth.allowTailscale` is `true`. Fased
verifies the identity by resolving the `x-forwarded-for` address with
`tailscale whois` and matching it to the header, and only accepts these when the
request hits loopback with Tailscale’s `x-forwarded-*` headers. Set
`gateway.auth.allowTailscale: false` (or force `gateway.auth.mode: "password"`)
if you want to require a token/password even for Serve traffic.
Tokenless Serve auth assumes the gateway host is trusted. If untrusted local
code may run on that host, require token/password auth.

### Bind to tailnet + token

```bash
fased gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Then open:

- `http://<tailscale-ip>:18789/` (or your configured `gateway.controlUi.basePath`)

Paste the token into the UI settings (sent as `connect.params.auth.token`).

## Insecure HTTP

If you open the dashboard over plain HTTP (`http://<lan-ip>` or `http://<tailscale-ip>`),
the browser runs in a **non-secure context** and blocks WebCrypto. By default,
Fased **blocks** Control UI connections without device identity.

**Recommended fix:** use HTTPS (Tailscale Serve) or open the UI locally:

- `https://<magicdns>/` (Serve)
- `http://localhost:18789/` (on the gateway host; preferred for browser auth features)

**Insecure-auth toggle behavior:**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

`allowInsecureAuth` does not bypass Control UI device identity or pairing checks.

**Break-glass only:**

```json5
{
  gateway: {
    controlUi: { dangerouslyDisableDeviceAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

`dangerouslyDisableDeviceAuth` disables Control UI device identity checks and is a
severe security downgrade. Revert quickly after emergency use.

See [Tailscale](/gateway/tailscale) for HTTPS setup guidance.

## Building the UI

The Gateway serves static files from `dist/control-ui`. Build them with:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

Optional absolute base (when you want fixed asset URLs):

```bash
FASED_CONTROL_UI_BASE_PATH=/fased/ pnpm ui:build
```

For local development (separate dev server):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

Then point the UI at your Gateway WS URL (e.g. `ws://127.0.0.1:18789`).

## Debugging/testing: dev server + remote Gateway

The Control UI is static files; the WebSocket target is configurable and can be
different from the HTTP origin. This is handy when you want the Vite dev server
locally but the Gateway runs elsewhere.

1. Start the UI dev server: `pnpm ui:dev`
2. Open a URL like:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

Optional one-time auth (if needed):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

Notes:

- `gatewayUrl` is stored in localStorage after load and removed from the URL.
- `token` is stored in localStorage; `password` is kept in memory only.
- When `gatewayUrl` is set, the UI does not fall back to config or environment credentials.
  Provide `token` (or `password`) explicitly. Missing explicit credentials is an error.
- Use `wss://` when the Gateway is behind TLS (Tailscale Serve, HTTPS proxy, etc.).
- `gatewayUrl` is only accepted in a top-level window (not embedded) to prevent clickjacking.
- Non-loopback Control UI deployments must set `gateway.controlUi.allowedOrigins`
  explicitly (full origins). This includes remote dev setups.
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` enables
  Host-header origin fallback mode, but it is a dangerous security mode.

Example:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Remote access setup details: [Remote access](/gateway/remote).
