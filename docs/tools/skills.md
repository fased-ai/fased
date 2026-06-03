---
summary: "Skills: managed vs workspace, gating rules, and config/env wiring"
read_when:
  - Adding or modifying skills
  - Changing skill gating or load rules
title: "Skills"
---

# Skills

Fased uses **[AgentSkills](https://agentskills.io)-compatible** skill folders to teach the agent how to use tools. Each skill is a directory containing a `SKILL.md` with YAML frontmatter and instructions. Fased loads **bundled skills** plus optional local overrides, and filters them at load time based on environment, config, and binary presence.

## Locations and precedence

Skills are loaded from several sources:

1. **Extra configured folders and plugin skill folders**: `skills.load.extraDirs`
   in `~/.fased/fased.json` plus enabled extension skill directories
2. **Bundled skills**: shipped with the install or app bundle
3. **Managed/shared skills**: `~/.fased/skills`
4. **User AgentSkills**: `~/.agents/skills`
5. **Project AgentSkills**: `<workspace>/.agents/skills`
6. **Agent workspace skills**: `<workspace>/skills`

If a skill name conflicts, precedence is:

`<workspace>/skills` (highest) → `<workspace>/.agents/skills` →
`~/.agents/skills` → `~/.fased/skills` → bundled skills → extra/plugin folders
(lowest).

## Per-agent vs shared skills

In **multi-agent** setups, each agent has its own workspace. That means:

- **Per-agent skills** live in `<workspace>/skills` for that agent only.
- **Shared skills** live in `~/.fased/skills` (managed/local) and are visible
  to **all agents** on the same machine.
- **Shared folders** can also be added via `skills.load.extraDirs` (lowest
  precedence) if you want a common skills pack used by multiple agents.

If the same skill name exists in more than one place, the usual precedence
applies: workspace wins, then managed/local, then bundled.

## Plugins + skills

Plugins can ship their own skills by listing `skills` directories in
`fased.plugin.json` (paths relative to the plugin root). Plugin skills load
when the plugin is enabled. They share the lowest precedence tier with
`skills.load.extraDirs`, so bundled/shared/workspace copies can override them by
name.
You can gate them via `metadata.fased.requires.config` on the plugin’s config
entry. See [Plugins](/tools/plugin) for discovery/config and [Tools](/tools) for the
tool surface those skills teach.

## Plugin Catalog (install + sync)

The plugin catalog is the public skills registry for Fased. Use it to discover
and publish skills. Full guide: [Plugin Catalog](/tools/clawhub).

In the dashboard, the normal user surface is **Agents > select Agent > Skills**.
That tab contains the skill library, plugin-catalog search/review/install,
create skill, edit/configure, dependency install, and the per-Agent access
toggle. A skill can be available in the library without being allowed for the
selected Agent.

Marketplace installs can target the shared skill library (`~/.fased/skills`) or
the selected Agent workspace. The target is shown in the install review before
any files are written.

Use **+ Skill** in **Agent > Skills** to create a new workspace skill. The create
dialog writes a real editable `SKILL.md` into the selected Agent workspace and
offers starter templates for general workflows, research/review, tool/API
workflows, wallet-safe workflows, operational runbooks, task automation, and
channel workflows. Templates are built-in starters; create the skill, then edit
its `SKILL.md` to make it specific. Bundled or plugin-owned skills stay read-only
until copied into an Agent workspace.

Fased also includes a bundled **skill-workshop** skill. It is review-only: it
drafts a proposed `SKILL.md`, dependency list, and access review, but it must not
write files, install dependencies, or grant tools/wallets by itself. Save the
draft through **Agent > Skills > + Skill** or the Skill editor after review.

Install targets mean:

- **Shared library**: reusable skill source that Agents can allow.
- **Agent workspace**: editable skill copy saved under that Agent's workspace.
- **Default Agent workspace**: the current default Agent, usually `Assistant`.

## Skill sources and setup blockers

Skills have a **source** and a separate **readiness state**. Do not treat those
as the same thing.

| Source          | What it means                                             | Where it lives                             |
| --------------- | --------------------------------------------------------- | ------------------------------------------ |
| Bundled         | Shipped with Fased. Read-only until copied.               | `agent/fased/skills/...` or the app bundle |
| Shared library  | Installed or created once for all Agents on this machine. | `~/.fased/skills/...`                      |
| Agent workspace | Editable skill owned by one Agent workspace.              | `<agent workspace>/skills/...`             |
| Plugin catalog  | Downloaded after review from the skills registry.         | Shared library or an Agent workspace       |
| Plugin skill    | Supplied by an enabled extension.                         | The extension's skill directory            |

Readiness blockers tell the operator what still needs setup:

- **Needs dependency** means the `SKILL.md` exists, but a required executable is
  missing from the gateway `PATH`.
- **Unsupported OS** means the skill declares an OS requirement such as
  `darwin`, and the current gateway or paired skill runtime does not match it.
- **Needs config** means the skill depends on a config path or account setup.
- **Needs API key/env** means the skill needs a secret value saved under
  `skills.entries.<skill-id>`.
- **Ready** means the skill source is present and all declared requirements are
  visible to the gateway process.

Example: `blogwatcher` is a bundled skill that teaches the Agent how to monitor
RSS/Atom feeds, but it requires the external `blogwatcher` CLI. Clicking its
install action runs only the declared dependency installer for that CLI. It does
not install the skill itself, grant tools, grant wallets, or attach the skill to
an Agent. If the installer uses Go and `go` is missing, Fased stops and tells
you to install Go first; it does not silently install Go, Homebrew, or apt
packages for you. `blogwatcher` uses Go because its own `SKILL.md` declares:
`github.com/Hyaxia/blogwatcher/cmd/blogwatcher@latest`. Other skills can declare
different installers, such as npm, uv, brew, or a direct download.

Example: `bluebubbles` is a bundled skill that depends on the BlueBubbles channel
account. Its `config:channels.bluebubbles` requirement is not skill-local JSON.
The skill detail modal can edit that root config path directly, or you can use
**Agent > Channels** for the fuller channel account UI. The skill becomes ready
when the channel account config and credentials are present. Skill config is
only for values owned by the skill itself.

Homebrew on Linux is Linuxbrew. It can work on WSL, but the gateway process must
see the Linuxbrew `bin` directory in `PATH`. If you run Fased from systemd,
Docker, or another non-login process, install dependencies inside that runtime or
explicitly set the service `PATH`.

Skill dependency installs always run as the **gateway process user**. Local,
Hosting/VPS, Docker, and systemd profiles can have different usernames, `HOME`
directories, write permissions, and `PATH` values. Fased checks the active
gateway environment after an installer runs; it does not assume `/home/fc`,
`/root`, root access, or an interactive shell profile. If npm/go/uv installs a
binary into that user's home or a custom prefix but the gateway cannot see it on
`PATH`, the install is reported as incomplete until you update the gateway
environment and restart.

Dependency installers are an external package trust boundary. Before running
`npm`, `go`, `uv`, `brew`, or direct download installers, **Agent > Skills** shows
whether the installer is exact-version pinned and whether the source has
`integrity`, `sha256`, or `shasum` metadata. Fased warns instead of silently
trusting `latest`, ranges, unpinned Homebrew formulas, or archives without a
hash. The install is still separate from skill access: it does not grant Agent
tools, wallet access, mining access, or task autonomy.

### Create a template skill in the UI

Use this path when you want to write a new skill from a starter template:

1. Open **Agents**, select the Agent, then open **Agent > Skills**.
2. Click **+ Skill**.
3. Enter a short **Name** and a practical **Description**.
4. Pick a **Template**:
   - **General workflow** for broad step-by-step instructions.
   - **Research/review** for source checking and evidence synthesis.
   - **Tool/API workflow** for API, CLI, or service-backed procedures.
   - **Wallet-safe workflow** for wallet-aware planning with explicit grant checks.
   - **Operational runbook** for triage, remediation, and escalation.
   - **Task automation** for scheduled or worker-backed task workflows.
   - **Channel workflow** for Telegram, Discord, Slack, or other app behavior.
5. Pick **Save in Agent**. Use `Assistant` for the default Agent, or another
   Agent name when the skill should be owned by that Agent.
6. Click **Create skill**. Fased writes a real editable `SKILL.md`.
7. Open the new skill from **Agent > Skills** and edit `SKILL.md`.
8. Allow the skill on the Agent from the skill detail **Agent access** section
   or from the row toggle.

The template is only starter text. It does not grant tools, service credentials,
wallet access, mining access, or task autonomy. Configure those separately in
**Services**, **Agent > Tools**, **Wallets > Skill Grants**, and **Agent > Skills**.

Status words in the UI are intentionally separate:

- **Installed** means Fased found a skill folder with `SKILL.md`.
- **Ready** means the skill is installed and all required binaries, env values,
  config values, and OS requirements are visible to the gateway process.
- **Needs dependency** means the skill exists, but an external binary such as
  `gh`, `op`, or `eightctl` is missing from the gateway `PATH`. In WSL, install
  the binary inside WSL or expose it to the process that runs Fased.
- **Unsupported OS** means the skill is for another platform, such as a macOS
  skill on a Linux/WSL gateway. Pair a matching node or use a cross-platform
  alternative.
- **Configure** saves skill-specific config or env values. It does not install
  binaries and does not grant tools or wallets.
- **Make editable copy** copies a read-only bundled/shared skill into the
  selected Agent workspace so its `SKILL.md` can be edited. It is not a security
  grant and it does not change which Agents may use the skill.

**Agent > Skills** has three access modes for the selected Agent:

- **Inherits all**: no per-Agent allowlist; the Agent can use every enabled skill.
- **Explicit allowlist**: the Agent can use only the selected skills.
- **No skills**: the Agent receives no skill instructions or skill tools.

Normal user flow:

1. Open **Agents**, select the Agent, then open **Agent > Skills**.
2. Search the plugin catalog or use an existing bundled/workspace/shared skill.
3. Review install/download safety, then install into the shared library or the
   selected Agent workspace.
4. To edit a bundled, plugin-owned, or extra-folder skill, copy it into the
   Agent workspace first. The editor only writes managed/shared skills and
   workspace copies.
5. Fix setup blockers in the skill detail modal: API key, binary dependency,
   config requirement, or enable/disable state.
6. Attach the skill to the Agent that should use it. You can do this from the
   skill detail modal's **Agent access** section or the row toggle.
7. If the skill calls tools, open **Agent > Tools** and allow the required tools.
   If it needs API credentials, connect the API in **Services**. If it can move
   funds, open the **Wallets > Skill Grants** tab and grant only the narrow wallet actions.
8. Use the skill in chat or tasks. Tasks inherit the owning Agent's skill
   allowlist unless the task explicitly narrows its selected skills.

Common flows:

- Install a skill into your Fased workspace:
  - `fased skills marketplace install <skill-slug>`
- Preview an update:
  - `fased skills marketplace update <skill-slug> --dry-run`
- Apply a reviewed risky update:
  - `fased skills marketplace update <skill-slug> --approve-permission-change`
- Sync (scan + publish updates):
  - `clawhub sync --all`

Fased marketplace install/update records the plugin source, archive scan,
requested permissions, and update review in `<workspace>/skills/<skill>/.clawhub/origin.json`.
Use the raw catalog CLI directly for discovery and publishing workflows.

## Wallet-capable skills

Installed or custom skills do not receive wallet access automatically. The
operator must grant the exact wallet actions, route mints, registry origin, and
automation scope that the skill may use.

In the dashboard, use the **Wallets > Skill Grants** tab to review
wallet-capable skills and grant only the actions, chain, mint route, amount cap,
slippage cap, and automation flags you intend to allow. The UI shows the wallet
permissions recorded during plugin install review next to the current grant and
writes the same `skills.entries.<skill-id>.config.walletActions` path as the CLI.
The list is intentionally empty until a plugin review records wallet
permissions or an existing wallet grant is present.

Use the CLI helper when you need scriptable setup or a raw admin path:

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

This writes `skills.entries.reviewed-wallet-skill.config.walletActions` and, when
`--registry` is provided, adds the registry to
`skills.marketplace.allowRegistries`.

Wallet grants are always explicit Agent-wallet grants. A skill must be granted
the specific Agent wallet ids it may use, such as `agent` or `agent-2`.
Skills cannot use Mining wallets or Vault wallets for generic wallet actions.
Installed plugin-catalog skills are also checked against
`<workspace>/skills/<skill>/.clawhub/origin.json`; wallet actions are rejected
unless the recorded registry is allowlisted.

Mining is a separate runtime surface. Mining skills may teach the Agent how to
read mining status or call mining tools when those tools are explicitly allowed,
but generic marketplace skills do not gain custody over the mining wallet. SAT
mining wallet actions stay behind the mining tool policy, runtime approvals, and
the dedicated mining wallet path.

Plugin-catalog installs record the wallet permissions, requested tool access, and
install metadata requested by the skill. Updates that add or change risky wallet
permissions, tool access, install metadata, or new archive scan warnings are
blocked until explicitly approved. Fased also scans plugin archives before
install and rejects hidden package scripts, installer scripts, sensitive files,
native binary artifacts, dangerous source-code patterns, dependency blocks,
symlinks, VCS folders, `node_modules`, and oversized files. Dependency manifests
and helper scripts are recorded as review warnings. To review installed plugin
sources, requested permissions, archive scan status, and current grants:

```bash
fased skills marketplace list
fased skills permissions reviewed-wallet-skill
```

For review-only setup, use:

```bash
fased skills wallet grant reviewed-wallet-skill --actions send --dry-run --json
```

## Security notes

- Treat third-party skills as **untrusted code**. Read them before allowing
  them on an Agent.
- Dependency installers are blocked when the local scanner finds critical
  dangerous-code patterns in the skill source. Review or remove the skill
  instead of installing dependencies blindly.
- Prefer sandboxed runs for untrusted inputs and risky tools. See [Sandboxing](/gateway/sandboxing).
- `skills.entries.*.env` and `skills.entries.*.apiKey` inject secrets into the **host** process
  for that agent turn (not the sandbox). Keep secrets out of prompts and logs.
- Use **Wallets > Skill Grants** for wallet-capable skills so wallet routes,
  token mints, registry origins, and autonomous permissions stay explicit.
  `fased skills wallet grant` is the scriptable equivalent.
- For a broader threat model and checklists, see [Security](/gateway/security).

## Format (AgentSkills-compatible)

`SKILL.md` must include at least:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

Notes:

- We follow the AgentSkills spec for layout/intent.
- The parser used by the embedded agent supports **single-line** frontmatter keys only.
- `metadata` should be a **single-line JSON object**.
- Use `{baseDir}` in instructions to reference the skill folder path.
- Optional frontmatter keys:
  - `homepage` — URL surfaced as “Website” in the skill detail UI (also supported via `metadata.fased.homepage`).
  - `user-invocable` — `true|false` (default: `true`). When `true`, the skill is exposed as a user slash command.
  - `disable-model-invocation` — `true|false` (default: `false`). When `true`, the skill is excluded from the model prompt (still available via user invocation).
  - `command-dispatch` — `tool` (optional). When set to `tool`, the slash command bypasses the model and dispatches directly to a tool.
  - `command-tool` — tool name to invoke when `command-dispatch: tool` is set.
  - `command-arg-mode` — `raw` (default). For tool dispatch, forwards the raw args string to the tool (no core parsing).

    The tool is invoked with params:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## Gating (load-time filters)

Fased **filters skills at load time** using `metadata` (single-line JSON):

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata:
  {
    "fased":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

Fields under `metadata.fased`:

- `always: true` — always include the skill (skip other gates).
- `emoji` — optional emoji used by the skill detail UI.
- `homepage` — optional URL shown as “Website” in the skill detail UI.
- `os` — optional list of platforms (`darwin`, `linux`, `win32`). If set, the skill is only eligible on those OSes.
- `requires.bins` — list; each must exist on `PATH`.
- `requires.anyBins` — list; at least one must exist on `PATH`.
- `requires.env` — list; env var must exist **or** be provided in config.
- `requires.config` — list of `fased.json` paths that must be truthy.
- `primaryEnv` — env var name associated with `skills.entries.<name>.apiKey`.
- `install` — optional array of installer specs used by Agent > Skills dependency install (brew/node/go/uv/download).

Note on sandboxing:

- `requires.bins` is checked on the **host** at skill load time.
- If an agent is sandboxed, the binary must also exist **inside the container**.
  Install it via `agents.defaults.sandbox.docker.setupCommand` (or a custom image).
  `setupCommand` runs once after the container is created.
  Package installs also require network egress, a writable root FS, and a root user in the sandbox.
  Example: the `summarize` skill (`skills/summarize/SKILL.md`) needs the `summarize` CLI
  in the sandbox container to run there.

Installer example:

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "fased":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

Notes:

- If multiple installers are listed, the gateway picks a **single** preferred option (brew when available, otherwise node).
- If all installers are `download`, Fased lists each entry so you can see the available artifacts.
- Installer specs can include `os: ["darwin"|"linux"|"win32"]` to filter options by platform.
- Node installs honor `skills.install.nodeManager` in `fased.json` (default: npm; options: npm/pnpm/yarn/bun).
  This only affects **skill installs**; the Gateway runtime should still be Node
  (Bun is not recommended for WhatsApp/Telegram).
- Prefer exact installer pins: `package@1.2.3` for npm, `module@v1.2.3` for Go,
  and `package==1.2.3` for uv. Homebrew formulas are treated as unpinned package
  manager installs unless paired with separate trust metadata.
- Installer specs can include `integrity`, `sha256`, or `shasum` so the UI and
  review surfaces can warn less aggressively and detect missing source pins.
- Go and uv installs require `go` or `uv` to already be available to the
  gateway process. Fased does not silently install toolchain managers.
- Installer success requires verification. When a spec declares `bins`, Fased
  re-checks those binaries after the command exits. Exit code `0` is not enough:
  if the binary is still missing from gateway `PATH`, the install is reported as
  failed with a PATH hint.
- Download installs: `url` (required), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (default: auto when archive detected), `stripComponents`, `targetDir` (default: `~/.fased/tools/<skillKey>`).

If no `metadata.fased` is present, the skill is always eligible (unless
disabled in config or blocked by `skills.allowBundled` for bundled skills).

## Config overrides (`~/.fased/fased.json`)

Bundled/managed skills can be toggled and supplied with env values:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" }, // or plaintext string
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

Note: if the skill name contains hyphens, quote the key (JSON5 allows quoted keys).

Config keys match the **skill name** by default. If a skill defines
`metadata.fased.skillKey`, use that key under `skills.entries`.

Rules:

- `enabled: false` disables the skill even if it’s bundled/installed.
- `env`: injected **only if** the variable isn’t already set in the process.
- `apiKey`: convenience for skills that declare `metadata.fased.primaryEnv`.
  Supports plaintext string or SecretRef object (`{ source, provider, id }`).
- `config`: optional bag for custom per-skill fields; custom keys must live here.
- `allowBundled`: optional allowlist for **bundled** skills only. If set, only
  bundled skills in the list are eligible (managed/workspace skills unaffected).

## Environment injection (per agent run)

When an agent run starts, Fased:

1. Reads skill metadata.
2. Applies any `skills.entries.<key>.env` or `skills.entries.<key>.apiKey` to
   `process.env`.
3. Builds the system prompt with **eligible** skills.
4. Restores the original environment after the run ends.

This is **scoped to the agent run**, not a global shell environment.

## Session snapshot (performance)

Fased snapshots the eligible skills **when a session starts** and reuses that list for subsequent turns in the same session. Changes to skills or config take effect on the next new session.

Skills can also refresh mid-session when the skills watcher is enabled or when a new eligible remote node appears (see below). Think of this as a **hot reload**: the refreshed list is picked up on the next agent turn.

## Remote macOS nodes (Linux gateway)

If the Gateway is running on Linux but a **macOS node** is connected **with `system.run` allowed** (Exec approvals security not set to `deny`), Fased can treat macOS-only skills as eligible when the required binaries are present on that node. The agent should execute those skills via the `nodes` tool (typically `nodes.run`).

This relies on the node reporting its command support and on a bin probe via `system.run`. If the macOS node goes offline later, the skills remain visible; invocations may fail until the node reconnects.

## Skills watcher (auto-refresh)

By default, Fased watches skill folders and bumps the skills snapshot when `SKILL.md` files change. Configure this under `skills.load`:

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## Token impact (skills list)

When skills are eligible, Fased injects a compact XML list of available skills into the system prompt through the embedded agent prompt formatter. The cost is deterministic:

- **Base overhead (only when ≥1 skill):** 195 characters.
- **Per skill:** 97 characters + the length of the XML-escaped `<name>`, `<description>`, and `<location>` values.

Formula (characters):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Notes:

- XML escaping expands `& < > " '` into entities (`&amp;`, `&lt;`, etc.), increasing length.
- Token counts vary by model tokenizer. A rough OpenAI-style estimate is ~4 chars/token, so **97 chars ≈ 24 tokens** per skill plus your actual field lengths.

## Managed skills lifecycle

Fased ships a baseline set of skills as **bundled skills** as part of the
install or macOS app bundle. `~/.fased/skills` exists for local
overrides (for example, pinning/patching a skill without changing the bundled
copy). Workspace skills are user-owned and override both on name conflicts.

## Config reference

See [Skills config](/tools/skills-config) for the full configuration schema.

## Looking for more skills?

Open **Agent > Skills** and use the plugin catalog search.

---
