---
summary: "Skills config schema and examples"
read_when:
  - Adding or modifying skills config
  - Adjusting bundled allowlist or install behavior
title: "Skills Config"
---

# Skills Config

Normal skill setup happens in the Control UI:

- **Agents > select Agent > Skills** installs, creates, edits,
  configures, and allows skills for that Agent.
- **Wallets > Skill Grants** grants reviewed wallet-capable skills narrow
  access to selected Agent wallets.
- **Agent > Tools** controls whether that Agent may use the resulting tool
  surfaces.

This page documents the raw `skills` config under `~/.fased/fased.json` for
automation, review, and advanced troubleshooting.

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    marketplace: {
      allowRegistries: ["https://clawhub.com"],
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" }, // or plaintext string
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## Fields

- `allowBundled`: optional allowlist for **bundled** skills only. When set, only
  bundled skills in the list are eligible (managed/workspace skills unaffected).
- `load.extraDirs`: additional skill directories to scan (lowest precedence).
- `load.watch`: watch skill folders and refresh the skills snapshot (default: true).
- `load.watchDebounceMs`: debounce for skill watcher events in milliseconds (default: 250).
- `install.preferBrew`: prefer brew installers when available (default: true).
- `install.nodeManager`: node installer preference (`npm` | `pnpm` | `yarn` | `bun`, default: npm).
  This only affects **skill installs**; the Gateway runtime should still be Node
  (Bun not recommended for WhatsApp/Telegram).
- `marketplace.allowRegistries`: registry origins that installed skills may
  use for sensitive gated capabilities such as wallet actions.
- `entries.<skillKey>`: per-skill overrides.

Per-skill fields:

- `enabled`: set `false` to disable a skill even if it’s bundled/installed.
- `env`: environment variables injected for the agent run (only if not already set).
- `apiKey`: optional convenience for skills that declare a primary env var.
  Supports plaintext string or SecretRef object (`{ source, provider, id }`).
- `config.walletActions`: optional wallet-action grant for this skill. Prefer
  creating it with `fased skills wallet grant <skill-id>` instead of editing
  JSON manually.

## Wallet action grants

Wallet-capable skills require an explicit `walletActions` block before they can
request wallet actions.

Installed skills are discovered automatically, but they participate in an Agent
turn only when that Agent's skill access mode allows them. Wallet authority is
separate: a skill must still have a narrow `walletActions` grant before it can
request wallet actions.

Normal setup:

1. Open **Wallets > Skill Grants**.
2. Select the reviewed wallet-capable skill.
3. Grant only the needed Agent wallet ids, chains, mints, actions, caps, and
   automation flags.
4. Keep Mining and Vault wallet roles unavailable to normal skills.

Scripted setup:

```bash
fased skills wallet grant reviewed-wallet-skill \
  --registry https://clawhub.com \
  --actions send \
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

The generated shape is:

```json5
{
  skills: {
    marketplace: {
      allowRegistries: ["https://clawhub.com"],
    },
    entries: {
      "reviewed-wallet-skill": {
        enabled: true,
        config: {
          walletActions: {
            actions: ["send"],
            roles: ["agent"],
            walletIds: ["agent"],
            chains: ["solana"],
            registries: ["https://clawhub.com"],
            inputMints: ["So11111111111111111111111111111111111111112"],
            outputMints: ["<TOKEN_MINT>"],
            maxAmount: "100000000",
            maxSlippageBps: 50,
            autonomous: true,
            cron: true,
          },
        },
      },
    },
  },
}
```

Rules:

- `roles` must be Agent-scoped; skills cannot use Mining or Vault wallets.
- mints are exact allowlists; symbols are not authority for execution.
- `maxAmount` is in base units for the input mint.
- installed plugin-catalog skills must come from an allowlisted registry origin.
- the grant command replaces the skill's wallet grant block so stale routes do
  not silently accumulate.
- Plugin-catalog installs record requested wallet permissions in
  `<workspace>/skills/<skill>/.clawhub/origin.json`; updates that add risky
  wallet permissions, requested tool access, install metadata, or new archive
  scan warnings are blocked until explicitly approved by the operator.
- Plugin archives are scanned before install. Symlinks, VCS folders,
  `node_modules`, oversized files, package lifecycle scripts, and package
  dependency blocks are rejected. Dependency manifests and helper scripts are
  recorded as review warnings.

Inspect installed marketplace sources and grant state:

```bash
fased skills marketplace list
fased skills marketplace list --json
fased skills permissions <skill-id>
```

## Notes

- Keys under `entries` map to the skill name by default. If a skill defines
  `metadata.fased.skillKey`, use that key instead.
- Changes to skills are picked up on the next agent turn when the watcher is enabled.

### Sandboxed skills + env vars

When a session is **sandboxed**, skill processes run inside Docker. The sandbox
does **not** inherit the host `process.env`.

Use one of:

- `agents.defaults.sandbox.docker.env` (or per-agent `agents.list[].sandbox.docker.env`)
- bake the env into your custom sandbox image

Global `env` and `skills.entries.<skill>.env/apiKey` apply to **host** runs only.
