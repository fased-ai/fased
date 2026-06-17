---
summary: "Tailscale Serve and Funnel for the gateway, with loopback-first and closed-port guidance."
read_when:
  - Exposing the Gateway Control UI outside localhost
  - Automating tailnet or public dashboard access
title: "Tailscale"
---

# Tailscale (Gateway dashboard)

Tailscale is the preferred remote-access layer when you want the gateway
reachable off the local machine without opening the raw gateway port to the wider
network. The intended pattern is loopback-first: keep the gateway on
`127.0.0.1`, then let Tailscale expose the control surface on top.

## Modes

- `serve`: Tailnet-only Serve via `tailscale serve`. The gateway stays on `127.0.0.1`.
- `funnel`: Public HTTPS via `tailscale funnel`. Fased requires a shared
  password. Use this as the exception, not the baseline.
- `off`: Default (no Tailscale automation).

## Recommended policy

- prefer `serve`
- keep the raw gateway port closed in your host firewall
- keep `gateway.bind: "loopback"` unless you need a direct tailnet bind
- use `funnel` only when you truly need public ingress

## First-time setup

For a manual laptop, desktop, or VPS install:

1. Create or sign in to a Tailscale account.
2. Install Tailscale on the gateway host.
3. Run `tailscale up` and complete the browser sign-in.
4. Keep Fased bound to loopback.
5. Use Tailscale Serve only when you want the Control UI reachable from other
   devices in your tailnet.

Linux host example:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
```

You do **not** need a Tailscale API key for a normal manual host. Use a
Tailscale auth key only for unattended provisioning, cloud-init, Terraform, or
other non-interactive installs.

## Auth

Set `gateway.auth.mode` to control the handshake:

- `token` (default when `FASED_GATEWAY_TOKEN` is set)
- `password` (shared secret via `FASED_GATEWAY_PASSWORD` or config)

When `tailscale.mode = "serve"` and `gateway.auth.allowTailscale` is `true`,
Control UI/WebSocket auth can use Tailscale identity headers
(`tailscale-user-login`) without supplying a token/password. Fased verifies
the identity by resolving the `x-forwarded-for` address via the local Tailscale
daemon (`tailscale whois`) and matching it to the header before accepting it.
Fased only treats a request as Serve when it arrives from loopback with
Tailscale’s `x-forwarded-for`, `x-forwarded-proto`, and `x-forwarded-host`
headers.
HTTP API endpoints (for example `/v1/*`, `/tools/invoke`, and `/api/channels/*`)
still require token/password auth.
This tokenless flow assumes the gateway host is trusted. If untrusted local code
may run on the same host, disable `gateway.auth.allowTailscale` and require
token/password auth instead.
To require explicit credentials, set `gateway.auth.allowTailscale: false` or
force `gateway.auth.mode: "password"`.

## Config examples

### Tailnet-only (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Open: `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`)

This is the normal recommendation for local and hosting profiles when you want
browser access from other devices on your tailnet.

### Tailnet-only (bind to Tailnet IP)

Use this when the gateway should listen directly on the tailnet IP instead of
staying on loopback behind Serve.

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Connect from another Tailnet device:

- Control UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

Note: loopback (`http://127.0.0.1:18789`) will **not** work in this mode.

### Public internet (Funnel + shared password)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

Prefer `FASED_GATEWAY_PASSWORD` over committing a password to disk.

This is the exception path, not the default recommendation.

## CLI examples

```bash
fased gateway --tailscale serve
fased gateway --tailscale funnel --auth password
```

## Notes

- Tailscale Serve/Funnel requires the `tailscale` CLI to be installed and logged in.
- `tailscale.mode: "funnel"` refuses to start unless auth mode is `password` to avoid public exposure.
- Set `gateway.tailscale.resetOnExit` if you want Fased to undo `tailscale serve`
  or `tailscale funnel` configuration on shutdown.
- `gateway.bind: "tailnet"` is a direct Tailnet bind (no HTTPS, no Serve/Funnel).
- `gateway.bind: "auto"` prefers loopback; use `tailnet` if you want Tailnet-only.
- Serve/Funnel only expose the **Gateway control UI + WS**. Nodes connect over
  the same Gateway WS endpoint, so Serve can work for node access.
- In the common loopback-plus-Serve path, you do not need to open port `18789` in the public firewall.

## Browser control (remote Gateway + local browser)

If you run the gateway on one machine but want to drive a browser on another machine,
run a **node host** on the browser machine and keep both on the same tailnet.
The Gateway will proxy browser actions to the node; no separate control server or Serve URL needed.

Avoid Funnel for browser control; treat node pairing like operator access.

## Tailscale prerequisites + limits

- Serve requires HTTPS enabled for your tailnet; the CLI prompts if it is missing.
- Serve injects Tailscale identity headers; Funnel does not.
- Funnel requires Tailscale v1.38.3+, MagicDNS, HTTPS enabled, and a funnel node attribute.
- Funnel only supports ports `443`, `8443`, and `10000` over TLS.
- Funnel on macOS requires the open-source Tailscale app variant.

## Learn more

- Tailscale Serve overview: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` command: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel overview: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` command: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
