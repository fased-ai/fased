---
summary: "Compatibility command for gateway service management"
read_when:
  - You still use `fased daemon ...` in scripts
  - You need service lifecycle commands for older automation
title: "daemon"
---

# `fased daemon`

Compatibility command for Gateway service management.

`fased daemon` maps to the same service-control surface documented under
[`fased gateway`](/cli/gateway).

## Usage

```bash
fased daemon status
fased daemon install
fased daemon start
fased daemon stop
fased daemon restart
fased daemon uninstall
```

## Subcommands

- `status`: show service install status and probe the Gateway
- `install`: install the service for the current platform
- `uninstall`: remove the service
- `start`: start the service
- `stop`: stop the service
- `restart`: restart the service

## Useful options

- `status --no-probe`: inspect service state without probing the Gateway.
- `status --deep`: scan platform service state more deeply.
- `install --port <port>`: install with a specific Gateway port.
- `install --runtime <node|bun>`: choose the runtime used by the service.
- `--json`: print machine-readable output where supported.

## Prefer `gateway`

Use [`fased gateway`](/cli/gateway) for current docs and examples.
