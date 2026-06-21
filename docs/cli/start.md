---
summary: "Start Fased in auto, managed, or gateway mode."
read_when:
  - You want the simplest command to start the runtime
  - You need to choose local gateway vs managed startup
title: "start"
---

# `fased start`

Start the runtime using Fased's current startup decision logic.

Browser equivalent: none. This is an operator command used before the browser
UI is available.

## Usage

```bash
fased start
fased start --mode auto
fased start --mode gateway
fased start --mode managed
```

Modes:

- `auto`: choose managed startup when the config needs federation, tunnel, or
  wallet preflight; otherwise start the local gateway
- `gateway`: start only the local gateway runtime
- `managed`: run the managed startup path

For direct gateway options such as port, bind mode, auth, and Tailscale, use
[`fased gateway`](/cli/gateway).

## Stop

If `fased start` is running in the current terminal, stop it with:

```bash
Ctrl+C
```

If Fased was installed as a local Gateway service, stop the service with:

```bash
fased gateway stop
```

On a hosted VPS install, the root-managed service runs as the non-root `app`
user. Normal operation should use:

```bash
fased gateway status
fased gateway restart
```

Stopping that hosted service is an admin action:

```bash
sudo systemctl stop fased-gateway.service
```

Related:

- [Gateway CLI](/cli/gateway)
- [Managed CLI](/cli/managed)
- [Install](/install/index)
