---
summary: "Inspect or replace exec approval policy for the local machine, gateway, or node hosts."
read_when:
  - You want to edit exec approvals from the CLI
  - You need to manage allowlists on gateway or node hosts
title: "approvals"
---

# `fased approvals`

Manage exec approvals for the local machine, the gateway host, or a connected
node host. By default the command edits the local approvals file on disk. Use
`--gateway` to target the gateway, or `--node` to target a specific node.

Browser equivalents: **Agent > Tools** for per-Agent tool access and
**Advanced > Nodes** for node host diagnostics. The CLI remains the precise way
to inspect or update host approval policies.

Related:

- Exec approvals: [Exec approvals](/tools/exec-approvals)
- Nodes: [Nodes](/nodes/index)

## Common commands

```bash
fased approvals get
fased approvals get --node <id|name|ip>
fased approvals get --gateway
fased approvals policy show
fased approvals policy show --node <id|name|ip>
fased approvals policy show --gateway
```

`policy show` is read-only. It resolves the current effective host approval
policy for the selected agent and target without rewriting config or approval
files.

## Set policy fields

```bash
fased approvals policy set --security allowlist --ask on-miss --ask-fallback deny
fased approvals policy set --agent main --security allowlist --ask always
fased approvals policy set --node <id|name|ip> --agent main --security deny
fased approvals policy set --gateway --auto-allow-skills off
```

Without `--agent`, `policy set` updates host defaults. With `--agent`, it writes
only that agent override. It does not rewrite `tools.exec.host` or other
runtime config.

## Policy presets

```bash
fased approvals policy preset locked-down
fased approvals policy preset cautious
fased approvals policy preset reviewed --agent main
fased approvals policy preset trusted-operator --yes
```

Presets write the same approval fields as `policy set`; they do not rewrite
`tools.exec.host` or other runtime config. `trusted-operator` is permissive and
requires `--yes`.

## Replace approvals from a file

```bash
fased approvals set --file ./exec-approvals.json
fased approvals set --node <id|name|ip> --file ./exec-approvals.json
fased approvals set --gateway --file ./exec-approvals.json
```

## Allowlist helpers

```bash
fased approvals allowlist add "~/Projects/**/bin/rg"
fased approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
fased approvals allowlist add --agent "*" "/usr/bin/uname"

fased approvals allowlist remove "~/Projects/**/bin/rg"
```

## Notes

- `--node` uses the same resolver as `fased nodes` (id, name, ip, or id prefix).
- `policy show` defaults to `main` when `--agent` is omitted.
- `policy set` updates host defaults when `--agent` is omitted.
- `allowlist add/remove` defaults to `"*"`, which applies to all agents.
- The node host must advertise `system.execApprovals.get/set` (macOS app or headless node host).
- Approvals files are stored per host at `~/.fased/exec-approvals.json`.
