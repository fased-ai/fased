---
summary: "macOS app flow for controlling a remote Fased gateway over SSH or a private direct link"
read_when:
  - Setting up or debugging remote mac control
title: "Remote Control"
---

# Remote Fased (macOS ⇄ remote host)

This flow lets the macOS app act as a full remote control for a Fased gateway
running on another host. It is the app's **Remote over SSH** feature. Health
checks, Voice Wake forwarding, Chat, and the browser Control UI reuse the same
remote connection settings from _Settings → General_.

## Modes

- **Local (this Mac)**: Everything runs on the laptop. No SSH involved.
- **Remote over SSH (default)**: Fased commands are executed on the remote host. The Mac app opens an SSH connection with `-o BatchMode` plus your chosen identity/key and a local port-forward.
- **Remote direct (ws/wss)**: No SSH tunnel. The Mac app connects to the gateway URL directly. Prefer a private path such as Tailscale Serve or another private reverse proxy.

## Remote transports

Remote mode supports two transports:

- **SSH tunnel** (default): Uses `ssh -N -L ...` to forward the gateway port to localhost. The gateway will see the node’s IP as `127.0.0.1` because the tunnel is loopback.
- **Direct (ws/wss)**: Connects straight to the gateway URL. The gateway sees the real client IP.

## Prereqs on the remote host

1. Install Node + pnpm and install the repo-backed Fased CLI:

   ```bash
   git clone https://github.com/fased-ai/fased.git fased
   cd fased
   ./install.sh --no-onboard
   ```

2. Ensure `fased` is on PATH for non-interactive shells (symlink into `/usr/local/bin` or `/opt/homebrew/bin` if needed).
3. Open SSH with key auth. We recommend **Tailscale** IPs or MagicDNS names for stable private reachability off-LAN.

## macOS app setup

1. Open _Settings → General_.
2. Under **FasedAgent runs**, pick **Remote over SSH** and set:
   - **Transport**: **SSH tunnel** or **Direct (ws/wss)**.
   - **SSH target**: `user@host` (optional `:port`).
     - If the gateway is on the same LAN and advertises Bonjour, pick it from the discovered list to auto-fill this field.
   - **Gateway URL** (Direct only): `wss://gateway.example.ts.net` (or `ws://...` for local/LAN/private overlay).
   - **Identity file** (advanced): path to your key.
   - **Project root** (advanced): remote checkout path used for commands.
   - **CLI path** (advanced): optional path to a runnable `fased` entrypoint/binary (auto-filled when advertised).
3. Hit **Test remote**. Success indicates the remote `fased status --json` runs correctly. Failures usually mean PATH/CLI issues; exit 127 means the CLI isn’t found remotely.
4. Health checks, Chat, and Control UI access will now run through the same
   remote path automatically.

## Chat and Control UI

- **SSH tunnel**: the mac app forwards the Gateway control port (default
  `18789`) to localhost.
- **Direct (ws/wss)**: the mac app connects straight to the configured Gateway
  URL.
- There is no separate Chat HTTP server anymore. Open
  `http://localhost:18789` and use the same Control UI pages as local mode:
  **Dashboard**, **Chat**, **Agents**, and **Advanced**.

## Permissions

- If the remote host is another Mac running the Fased macOS app or node mode,
  that Mac needs the same TCC approvals as local (Automation, Accessibility,
  Screen Recording, Microphone, Speech Recognition, Notifications). Run
  onboarding on that machine to grant them once.
- If the remote host is Linux/VPS-only, macOS TCC does not apply; only the
  connected Mac node can provide camera, screen, voice, and notification
  capabilities.
- Nodes advertise their permission state via `node.list` / `node.describe` so agents know what’s available.

## Security notes

- Prefer loopback binds on the remote host and connect via SSH or Tailscale.
- SSH tunneling uses strict host-key checking; trust the host key first so it exists in `~/.ssh/known_hosts`.
- If you bind the Gateway to a non-loopback interface, require token/password auth and keep it behind a private network or identity-aware proxy.
- See [Security](/security), [Gateway security](/gateway/security), and
  [Tailscale](/gateway/tailscale).

## WhatsApp login flow (remote)

- Run `fased channels login --verbose` **on the remote host**. Scan the QR with WhatsApp on your phone.
- Re-run login on that host if auth expires. Health check will surface link problems.
- Manage account routing in the Control UI under **Agent > Channels** after
  the remote login succeeds.

## Troubleshooting

- **exit 127 / not found**: `fased` isn’t on PATH for non-login shells. Add it to `/etc/paths`, your shell rc, or symlink into `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: check SSH reachability, PATH, and channel auth status (`fased status --json`).
- **Chat or Control UI stuck**: confirm the gateway is running on the remote
  host and the forwarded port matches the Gateway port; the UI requires a
  healthy connection.
- **Node IP shows 127.0.0.1**: expected with the SSH tunnel. Switch **Transport** to **Direct (ws/wss)** if you want the gateway to see the real client IP.
- **Voice Wake**: trigger phrases are forwarded automatically in remote mode; no separate forwarder is needed.

## Notification sounds

Pick sounds per notification from scripts with `fased` and `node.invoke`, e.g.:

```bash
fased nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

There is no global “default sound” toggle in the app anymore; callers choose a sound (or none) per request.
