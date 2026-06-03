---
summary: "Plugin catalog guide: public skills registry + CLI workflows"
read_when:
  - Introducing the skill/plugin catalog to new users
  - Installing, searching, or publishing skills
  - Explaining catalog CLI flags and sync behavior
title: "Plugin Catalog"
sidebarTitle: "Plugin Catalog"
---

# Plugin Catalog

The plugin catalog is the public skill registry for Fased. A skill is a folder
with a `SKILL.md` file plus optional supporting files. You can browse skills in
the web app or use the CLI to search, install, update, and publish skills.

Site: [clawhub.com](https://clawhub.com)

The underlying CLI is currently named `clawhub`, so command examples use that
binary name.

## What The Catalog Is

- A public registry for Fased skills.
- A versioned store of skill bundles and metadata.
- A discovery surface for search, tags, and usage signals.

## How it works

1. A user publishes a skill bundle (files + metadata).
2. The registry stores the bundle, parses metadata, and assigns a version.
3. The registry indexes the skill for search and discovery.
4. Users browse, download, and install skills in Fased.

## What you can do

- Publish new skills and new versions of existing skills.
- Discover skills by name, tags, or search.
- Download skill bundles and inspect their files.
- Report skills that are abusive or unsafe.
- If you are a moderator, hide, unhide, delete, or ban.

## Who this is for (beginner-friendly)

If you want to add new capabilities to your Fased agent, the catalog is the
normal discovery path. You do not need to know how the backend works. You can:

- Search for skills by plain language.
- Review and install a skill from **Agent > Skills**.
- Preview and update skills later through `fased skills marketplace update`.
- Back up your own skills by publishing them.

## Quick start (non-technical)

1. Open **Agents**, select the Agent, then open **Agent > Skills**.
2. Search for something you need:
   - `clawhub search "calendar"`
3. Review the skill before install. The Control UI and CLI both preview:
   - registry/source trust
   - requested wallet/tool/install permissions
   - archive file list and scan warnings
   - dependency/script policy
4. Install a skill through Fased so source and permissions are recorded:
   - `fased skills marketplace install <skill-slug>`
5. Allow the skill for the selected Agent if it should be used there.
6. Start a new Fased session so it picks up the new skill.

## Install the CLI

Pick one:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## How it fits into Fased

Use the catalog CLI for search, login, publishing, and registry maintenance.
Use the Fased CLI for normal installs and updates so Fased records registry
source, archive scan results, requested permissions, and update review metadata:

```bash
fased skills marketplace install <skill-slug>
fased skills marketplace update <skill-slug> --dry-run
fased skills marketplace update <skill-slug> --approve-permission-change
```

The Control UI uses the same Fased review/install path as the CLI from
**Agent > Skills**: search opens skill details, **Review install**
stages the archive in quarantine, and **Install** copies only the reviewed files
into the selected Agent workspace or shared skill library. A catalog install
never grants wallet signing, mining wallets, tool access, or autonomous
execution by itself; those grants stay in Wallet, Agent Tools, and task policy.

When the install target is an Agent, Fased installs into that Agent's
`<workspace>/skills` and loads the skill on the **next** session. When the
install target is the shared library, Fased installs into `~/.fased/skills`.
Agent workspace skills take precedence over shared and bundled skills.

For more detail on how skills are loaded, shared, and gated, see
[Skills](/tools/skills).

## Skill system overview

A skill is a versioned bundle of files that teaches Fased how to perform a
specific task. Each publish creates a new version, and the registry keeps a
history of versions so users can audit changes.

A typical skill includes:

- A `SKILL.md` file with the primary description and usage.
- Optional configs, scripts, or supporting files used by the skill.
- Metadata such as tags, summary, and install requirements.

The catalog uses metadata to power discovery and show requested skill capabilities.
The registry also tracks usage signals (such as stars and downloads) to improve
ranking and visibility.

## What the service provides (features)

- **Public browsing** of skills and their `SKILL.md` content.
- **Search** powered by embeddings (vector search), not just keywords.
- **Versioning** with semver, changelogs, and tags (including `latest`).
- **Downloads** as a zip per version.
- **Stars and comments** for community feedback.
- **Moderation** hooks for approvals and audits.
- **CLI-friendly API** for automation and scripting.

## Security and moderation

Do not rely on registry reputation alone. A registry may add account checks,
reports, hiding, or moderator review, but Fased still treats downloaded skills
as untrusted until the local review passes. The Fased-side guardrails are:

- trusted registry origin allowlist, defaulting to `https://clawhub.com`,
- quarantine download and safe archive extraction,
- required `SKILL.md`,
- archive scan warnings and blocks,
- explicit install review before files are copied into the Agent workspace,
- separate Agent skill access, tool grants, wallet grants, and task autonomy.

## Wallet-capable skills

Installing a skill does not grant wallet access. If a skill needs wallet tools,
the operator must grant a narrow `skills.entries.<skill>.config.walletActions`
block. Use the Fased CLI helper rather than editing JSON manually:

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

Installed catalog skills are checked against the registry recorded in
`<workspace>/skills/<skill>/.clawhub/origin.json`; wallet actions are rejected
unless that registry is allowlisted, normally `https://clawhub.com`. Wallet
actions are Agent-wallet-only. Mining and Vault wallets are not available to
third-party or custom skills for generic wallet actions.

Fased also records the wallet permissions, tool access, and install metadata a
catalog skill requests at install time. If an update adds or changes risky wallet
permissions, tool access, install metadata, or new archive scan warnings, the
update is blocked until the operator explicitly approves that permission change.
Installing or updating never creates a wallet grant by itself; use
`fased skills wallet grant` after reviewing the requested permissions.

Catalog skill archives are scanned before they are copied into the workspace.
Fased rejects archives with symlinks, VCS folders, `node_modules`, oversized
files, sensitive files such as `.env`/private keys, native binary artifacts,
installer scripts, package lifecycle scripts, dangerous source-code patterns, or
package dependency blocks. Dependency manifests and helper scripts are recorded
as review warnings. Skill dependencies should be declared through skill metadata
installers, not hidden in an install-time `package.json`.

Review installed catalog skill sources and wallet permission state:

```bash
fased skills marketplace list
fased skills marketplace list --json
fased skills permissions <skill-id>
```

## CLI commands and parameters

For normal Fased installs and updates, prefer `fased skills marketplace install`
and `fased skills marketplace update` so source checks, archive scan warnings,
and permission diffs are reviewed before files are installed or updated. Agent
access, tool grants, wallet grants, and task autonomy remain separate approvals.
The commands below document the raw catalog CLI for search, publishing, sync,
and advanced registry work.

Global options (apply to all commands):

- `--workdir <dir>`: Working directory (default: current dir; falls back to the Fased workspace).
- `--dir <dir>`: Skills directory, relative to workdir (default: `skills`).
- `--site <url>`: Site base URL (browser login).
- `--registry <url>`: Registry API base URL.
- `--no-input`: Disable prompts (non-interactive).
- `-V, --cli-version`: Print CLI version.

Auth:

- `clawhub login` (browser flow) or `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

Options:

- `--token <token>`: Paste an API token.
- `--label <label>`: Label stored for browser login tokens (default: `CLI token`).
- `--no-browser`: Do not open a browser (requires `--token`).

Search:

- `clawhub search "query"`
- `--limit <n>`: Max results.

Install:

- `clawhub install <slug>`
- `--version <version>`: Install a specific version.
- `--force`: Overwrite if the folder already exists.

Update:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: Update to a specific version (single slug only).
- `--force`: Overwrite when local files do not match any published version.

List:

- `clawhub list` (reads `.clawhub/lock.json`)

Publish:

- `clawhub publish <path>`
- `--slug <slug>`: Skill slug.
- `--name <name>`: Display name.
- `--version <version>`: Semver version.
- `--changelog <text>`: Changelog text (can be empty).
- `--tags <tags>`: Comma-separated tags (default: `latest`).

Delete/undelete (owner/admin only):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

Sync (scan local skills + publish new/updated):

- `clawhub sync`
- `--root <dir...>`: Extra scan roots.
- `--all`: Upload everything without prompts.
- `--dry-run`: Show what would be uploaded.
- `--bump <type>`: `patch|minor|major` for updates (default: `patch`).
- `--changelog <text>`: Changelog for non-interactive updates.
- `--tags <tags>`: Comma-separated tags (default: `latest`).
- `--concurrency <n>`: Registry checks (default: 4).

## Common workflows for agents

### Search for skills

```bash
clawhub search "postgres backups"
```

### Download new skills

```bash
fased skills marketplace install my-skill-pack
```

### Update installed skills

```bash
fased skills marketplace update --dry-run
fased skills marketplace update --approve-permission-change
```

### Back up your skills (publish or sync)

For a single skill folder:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

To scan and back up many skills at once:

```bash
clawhub sync --all
```

## Advanced details (technical)

### Versioning and tags

- Each publish creates a new **semver** `SkillVersion`.
- Tags (like `latest`) point to a version; moving tags lets you roll back.
- Changelogs are attached per version and can be empty when syncing or publishing updates.

### Local changes vs registry versions

Updates compare the local skill contents to registry versions using a content hash. If local files do not match any published version, the CLI asks before overwriting (or requires `--force` in non-interactive runs).

### Sync scanning and fallback roots

`clawhub sync` scans your current workdir first. If no skills are found, it falls back to known legacy locations (for example `~/fased/skills` and `~/.fased/skills`). This is designed to find older skill installs without extra flags.

### Storage and lockfile

- Installed skills are recorded in `.clawhub/lock.json` under your workdir.
- Auth tokens are stored in the catalog CLI config file (override via `CLAWHUB_CONFIG_PATH`).

### Telemetry (install counts)

When you run `clawhub sync` while logged in, the CLI sends a minimal snapshot to compute install counts. You can disable this entirely:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## Environment variables

- `CLAWHUB_SITE`: Override the site URL.
- `CLAWHUB_REGISTRY`: Override the registry API URL.
- `CLAWHUB_CONFIG_PATH`: Override where the CLI stores the token/config.
- `CLAWHUB_WORKDIR`: Override the default workdir.
- `CLAWHUB_DISABLE_TELEMETRY=1`: Disable telemetry on `sync`.

Existing `.clawhub` lockfiles are preserved so installed skills remain updateable.
