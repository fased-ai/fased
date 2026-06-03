---
summary: "Set up or inspect wide-area discovery helpers for gateway DNS-SD flows."
read_when:
  - You want wide-area discovery (DNS-SD) via Tailscale + CoreDNS
  - You’re setting up split DNS for a custom discovery domain (example: fased.internal)
title: "dns"
---

# `fased dns`

DNS helpers for wide-area discovery, mainly around Tailscale plus CoreDNS. The current guidance is centered on the macOS and Homebrew CoreDNS path.

Related:

- Gateway discovery: [Discovery](/gateway/discovery)
- Wide-area discovery config: [Configuration](/gateway/configuration)

## Setup

```bash
fased dns setup
fased dns setup --domain fased.internal
fased dns setup --apply
```

Without `--apply`, the command prints the recommended discovery config and the
Tailscale split-DNS settings to apply. With `--apply`, it installs or updates the
local CoreDNS config and restarts CoreDNS with `sudo`; that apply path is
currently macOS-only.

Options:

- `--domain <domain>`: discovery domain to serve, overriding `discovery.wideArea.domain`.
- `--apply`: write CoreDNS config and restart the service.
