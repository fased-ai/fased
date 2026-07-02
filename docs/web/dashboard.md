---
summary: "Dashboard access and auth for the browser Control UI."
read_when:
  - Changing dashboard authentication or exposure modes
title: "Dashboard"
---

# Dashboard (Control UI)

The dashboard is the browser Control UI served at `/` by default
(override with `gateway.controlUi.basePath`).

Quick open (local Gateway):

- [http://localhost:18789/](http://localhost:18789/) (preferred for browser auth features)
- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) if you explicitly want the numeric loopback host

The main dashboard now lives at `/dash` (`/` and `/overview` still route there
for compatibility). It is a compact widget board, not a setup wizard.

What the dashboard is for:

- see high-level Agent, task, session, usage, wallet, mining, and Fased Network state
- keep fast status widgets visible without opening each full control page
- open the top-bar Widgets drawer to add, remove, or reset widgets
- drag widgets by their header to reorder the saved board
- keep widgets compact; open the focused page when you need full tables, forms, or diagnostics
- keep low-level gateway access, raw config, Debug, and Nodes off the normal
  dashboard unless you open Advanced

Detailed setup and operation stay on focused pages:

- Agents: model choices, skills, chat apps, services, tools, saved context, tasks, and sessions
- Wallets: wallet roles, balances, approvals, passkeys, and security policy
- Mining: SAT mining controls, capital, live cycle, history, and recovery
- Usage: local model usage history by provider, model, Agent, session, task, and source
- Advanced: raw config, Debug, and Nodes tabs for admin diagnostics

Key references:

- [Control UI](/web/control-ui) for usage and UI capabilities.
- [Tailscale](/gateway/tailscale) for Serve/Funnel automation.
- [Web surfaces](/web) for bind modes and security notes.

Authentication is enforced at the WebSocket handshake via `connect.params.auth`
(token or password). See `gateway.auth` in [Gateway configuration](/gateway/configuration).

Security note: the Control UI is an **admin surface** (chat, config, wallet controls, mining, exec approvals).
Do not expose it publicly. The UI stores the token in `localStorage` after first load.
Prefer localhost, Tailscale Serve, or an SSH tunnel.

## Fast path (recommended)

- After onboarding, the CLI auto-opens the dashboard with an auth-ready local
  URL when a gateway token is configured.
- Re-open anytime: `fased dashboard` (copies the `#token=...` fragment link,
  opens the browser if possible, and shows an SSH hint if headless).
- Print the auth-ready URL without opening a browser:
  `fased dashboard --no-open`.
- From a source checkout, use:
  `node fased.mjs dashboard --no-open`.
- The token lives in the URL fragment, not the query string. The UI stores it
  locally and removes it from the visible URL after load.
- If the UI prompts for auth, paste the token from `gateway.auth.token` (or
  `FASED_GATEWAY_TOKEN`) into Control UI settings.

## Dashboard widgets

Default widgets are intentionally high-signal:

- **Agents**: total Agents, tasks, and sessions across Agents.
- **Usage**: seven-day token usage from local usage history.
- **Wallets**: SOL totals grouped by Agent, Mining, and Vault wallet roles.
- **Mining**: live mining status, mining wallet balance, locked capital, and seven-day SAT history.
- **Fased Network**: compact node identity and operator status.

Gateway access and low-level presence details are not normal dashboard widgets.
Use the top-bar health dot for live/offline status and the Advanced Debug/Nodes
tabs when you need low-level diagnostics.

The saved dashboard layout is one ordered widget board today. Older saved
multi-column layouts are normalized into that board so stale layout state does
not leave unsupported columns behind.

## Live session status

The dashboard subscribes to gateway session events after it connects. The
Chat page and **Agent > Sessions** show whether the session list and active-chat
message subscriptions are live, plus the last event time. If the WebSocket
reconnects, the UI resubscribes automatically and falls back to normal refresh
when a changed session is not already visible.

## Diagnostics

Dashboard widgets stay compact. Deep diagnostics live elsewhere:

- **Advanced > Config** for raw `~/.fased/fased.json` editing.
- **Advanced > Debug** for ordered diagnostics, status cards, memory repair
  preview, provider catalog, command catalog, plugin runtime, and raw RPC tools.
- **Advanced > Nodes** for paired devices, runtime command exposure, and node
  capabilities.
- **Logs** for live gateway file logs, filters, auto-follow, and export.
- **Usage** for local model usage history.

See [Memory Doctor](/concepts/memory-doctor) for the memory repair execution
boundary.

## Token basics (local vs remote)

- **Localhost**: open `http://localhost:18789/`.
- **Token source**: `gateway.auth.token` or `FASED_GATEWAY_TOKEN`. The UI stores
  a copy in localStorage after you connect.
- **Print URL**: `fased dashboard --no-open`.
- **Print raw token**: `fased config get gateway.auth.token`.
- **Not localhost**: use Tailscale Serve, tailnet bind with a token, or an SSH
  tunnel. Tailscale Serve can be tokenless for Control UI/WebSocket when
  `gateway.auth.allowTailscale: true`; HTTP APIs still need token/password.
  See [Web surfaces](/web).

## If you see “unauthorized” / 1008

- Ensure the gateway is reachable. Local check: `fased status`. Remote check:
  SSH tunnel with `ssh -N -L 18789:127.0.0.1:18789 user@host`, then open
  `http://localhost:18789/`.
- Retrieve the token from the gateway host:
  `fased config get gateway.auth.token`. To generate one:
  `fased doctor --generate-gateway-token`.
- In the dashboard settings, paste the token into the auth field, then connect.
