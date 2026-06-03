---
summary: "Health check steps for Gateway and channel connectivity"
read_when:
  - Diagnosing Gateway or channel health
title: "Health Checks"
---

# Health Checks (CLI)

Short guide to verify Gateway and channel connectivity without guessing.

## Quick checks

- `fased status` — local summary: gateway reachability/mode, update hint, linked channel auth age, sessions + recent activity.
- `fased status --all` — full local diagnosis (read-only, color, redacted where possible; review before sharing).
- `fased status --deep` — also probes the running Gateway (per-channel probes when supported).
- `fased health --json` — asks the running Gateway for a full health snapshot (WS-only; no direct Baileys socket).
- Send `/status` as a standalone message in WhatsApp/WebChat to get a status reply without invoking the agent.
- Logs: tail `/tmp/fased/fased-*.log` and filter for `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## Deep diagnostics

- Creds on disk: `ls -l ~/.fased/credentials/whatsapp/<accountId>/creds.json` (mtime should be recent).
- Session store: `ls -l ~/.fased/agents/<agentId>/sessions/sessions.json` (path can be overridden in config). Count and recent recipients are surfaced via `status`.
- Relink flow: use **Agent > Channels** for the normal WhatsApp QR/account flow.
  CLI repair is still available with `fased channels logout && fased channels
login --verbose` when status codes 409–515 or `loggedOut` appear in logs.
  The QR login flow auto-restarts once for status 515 after pairing.

## When something fails

- `logged out` or status 409–515 → relink from **Agent > Channels**, or use
  `fased channels logout` then `fased channels login` for CLI repair.
- Gateway unreachable:
  - local profile / source dev → start it with `fased gateway --port 18789` (use `--force` if the port is busy)
  - hosting profile / installed daemon → restart the managed service instead of opening the port directly
  - keep the gateway on loopback; use Tailscale Serve, a tailnet path, or SSH if you need remote access
- No inbound messages → confirm linked phone is online and the sender is allowed (`channels.whatsapp.allowFrom`); for group chats, ensure allowlist + mention rules match (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Dedicated "health" command

`fased health --json` asks the running Gateway for its health snapshot (no direct channel sockets from the CLI). It reports linked creds/auth age when available, per-channel probe summaries, session-store summary, and a probe duration. It exits non-zero if the Gateway is unreachable or the probe fails/timeouts. Use `--timeout <ms>` to override the 10s default.
