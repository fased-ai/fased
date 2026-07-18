---
summary: "Inspect skills, eligibility, and missing requirements from the CLI."
read_when:
  - You want to see which skills are available and ready to run
  - You want to debug missing binaries/env/config for skills
title: "skills"
---

# `fased skills`

Inspect skills from bundled, workspace, and managed sources, and see which ones are actually eligible to run.

Browser equivalent: **Agent > Skills**. That page owns ClawHub search/review,
create/edit/config, dependency install, and per-Agent skill access. The CLI is
for automation, install review, and admin repair.

Related:

- Skills system: [Skills](/tools/skills)
- Skills config: [Skills config](/tools/skills-config)
- ClawHub installs: [Plugin catalog](/tools/clawhub)

## Commands

```bash
fased skills list
fased skills list --eligible
fased skills list --json
fased skills info <name>
fased skills info <name> --json
fased skills inspect <name>
fased skills inspect <name> --json
fased skills check
fased skills check --json
fased skills wallet grant <skill-id> --wallet-id <agent-wallet-id> --actions quote,swap,schedule_send --max-amount <base-units>
fased skills marketplace list
fased skills marketplace list --json
fased skills permissions <skill-id>
fased skills permissions <skill-id> --json
fased skills marketplace install <slug>
fased skills marketplace install <slug> --version 1.2.3 --registry https://clawhub.com
fased skills marketplace install <slug> --dry-run
fased skills marketplace install <slug> --json
fased skills marketplace install <slug> --force --approve-permission-change
fased skills marketplace update [slug] --dry-run
fased skills marketplace update [slug] --approve-permission-change
fased skills marketplace update [slug] --json
```

## Wallet Grants

Skills do not receive wallet access just because they are installed. Grant
narrow wallet permissions only for the skill id and token route you intend to
use:

Normal users can do this from **Wallets > Skill Grants** in the browser UI.
That tab reads the ClawHub install review, shows requested wallet permissions
next to the current grant, and writes the same config path as this command. If
the tab is empty, no reviewed wallet-capable skill or existing grant has been
found yet. Use the CLI for automation, review-only JSON, or remote/admin setup.

```bash
fased skills wallet grant reviewed-wallet-skill \
  --registry https://clawhub.com \
  --actions quote,swap,schedule_plan,schedule_send \
  --role agent \
  --wallet-id agent \
  --chain solana \
  --input-mint So11111111111111111111111111111111111111112 \
  --output-mint <TOKEN_MINT> \
  --max-amount 100000000 \
  --max-slippage-bps 50 \
  --autonomous \
  --cron
```

The command writes `skills.entries.<skill-id>.config.walletActions`. If
`--registry` is provided, it also adds that registry to
`skills.marketplace.allowRegistries`. Wallet grants are Agent-wallet-only;
Mining and Vault wallets remain unavailable to skills.

Use `--dry-run --json` first when you want to review the exact config patch
without writing it:

```bash
fased skills wallet grant reviewed-wallet-skill \
  --actions quote,swap,schedule_send \
  --input-mint So11111111111111111111111111111111111111112 \
  --output-mint <TOKEN_MINT> \
  --max-amount 100000000 \
  --dry-run \
  --json
```

The helper replaces the skill's wallet permission block with the grant you
provide. That is intentional: wallet permissions should stay explicit and
small instead of accumulating stale routes over time.

The wallet-action names are policy controls for wallet-capable skills, not a
recommendation to run those actions. Risky actions such as `send`, `swap`,
`schedule_plan`, `schedule_send`, and `limit_order` require `--max-amount`.

## Marketplace Review

Install ClawHub skills through Fased so the archive scan, source allowlist, and
permission snapshot are recorded:

```bash
fased skills marketplace install reviewed-wallet-skill
fased skills marketplace install reviewed-wallet-skill --version 1.2.3
fased skills marketplace install reviewed-wallet-skill --dry-run
```

Use the marketplace view to inspect installed ClawHub sources, requested wallet
permissions recorded at install time, and the wallet grants currently active in
config:

```bash
fased skills marketplace list
fased skills marketplace list --json
```

ClawHub installs do not grant wallet access by themselves. Updates that add or
change risky wallet permissions, requested tool access, install metadata, or
new archive scan warnings are blocked until the operator explicitly approves
the permission change. Fresh installs use the same approval gate. The selected
registry version must publish a SHA-256/SRI archive digest; Fased refuses an
install whose digest is absent or whose downloaded bytes do not match.
Marketplace installs also record archive scan results:
sensitive files, native binaries, installer scripts, package lifecycle scripts,
dependency blocks, and dangerous source-code patterns are rejected; dependency
manifests and helper scripts are kept as review warnings.

Installed Marketplace instructions are untrusted runtime input. Fased excludes
their configured environment/API-key overrides, disables bundle MCP tools and
browser control, and forces a per-session sandbox with no network, no writable
workspace, a read-only root, and all Linux capabilities dropped. Normal mixed
skill turns expose only the `read` tool because a model tool call cannot prove
which Marketplace package requested it. An explicitly invoked tool-dispatch
command is still checked against that skill's recorded tool permission.

This boundary requires a working configured sandbox backend (Docker by
default). If it is unavailable, Marketplace-assisted turns fail closed instead
of running on the host. Locally authored, bundled, and managed skills retain
their configured trust and sandbox policy.

For local/bundled skills with dependency installers, Fased scans the skill
directory before running the installer. Critical dangerous-code findings block
the install instead of continuing with a warning.

Inspect one tracked marketplace skill when you do not want the full list:

```bash
fased skills permissions reviewed-wallet-skill
fased skills permissions reviewed-wallet-skill --json
```

Preview updates before applying them:

```bash
fased skills marketplace update reviewed-wallet-skill --dry-run
```

If the preview shows a new risky permission, install metadata, tool access, or
archive scan warning, apply only after review:

```bash
fased skills marketplace update reviewed-wallet-skill --approve-permission-change
```
