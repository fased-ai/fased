---
summary: "Run the managed startup preflight for gateway, Fased Network, tunnel, and wallet checks."
read_when:
  - You run hosted/public Fased surfaces
  - You need managed startup diagnostics before launch
title: "managed"
---

# `fased managed`

`fased managed` is the operator surface for managed/public startup helpers. It
is separate from normal Agent setup.

Browser equivalent: **Dashboard** and **Advanced** show the resulting runtime
state, but managed startup itself is a CLI/server operation.

## Usage

```bash
fased managed up
fased managed up --json
```

`managed up` runs the managed lifecycle preflight for the gateway, Fased
Network, tunnel exposure, and wallet checks. Without `--json`, it starts the
managed shell startup script. With `--json`, it prints the resolved script path
and preflight summary for deployment scripts.

For ordinary local use, start with:

```bash
fased start --mode gateway
```

Related:

- [Gateway CLI](/cli/gateway)
- [Fased Network CLI](/cli/federation)
- [Wallet CLI](/cli/wallet)
