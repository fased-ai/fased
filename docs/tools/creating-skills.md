---
title: "Creating Skills"
summary: "Build and test custom workspace skills with SKILL.md"
read_when:
  - You are creating a new custom skill in your workspace
  - You need a quick starter workflow for SKILL.md-based skills
---

# Creating Custom Skills

Fased is designed to be extensible. Skills are the primary way to add new
capabilities to your Agent.

## What is a Skill?

A skill is a directory containing a `SKILL.md` file with instructions for the
model, plus optional scripts or resources.

In the Control UI, these words have specific meanings:

- **Installed**: Fased found the skill directory and `SKILL.md`.
- **Ready**: the skill is installed and its required binaries, environment values,
  and config are available to the gateway process.
- **Needs dependency**: the skill file exists, but an external binary such as
  `gh`, `op`, or `eightctl` is not on the gateway `PATH`. On WSL, install it in
  WSL or expose it to the process that runs the gateway.
- **Unsupported OS**: the skill is scoped to another platform, such as a
  macOS-only skill on Linux/WSL. Pair a matching node or use a cross-platform
  alternative.
- **Configure**: save skill-specific env/config values under
  `skills.entries.<skill-id>`. This is separate from channel credentials and
  model providers.
- **Make editable copy**: bundled and shared skills are read-only. Copying creates
  a writable `SKILL.md` in the selected Agent workspace; it does not install
  external binaries or grant tool/wallet access.

There are several skill sources:

- **Bundled** skills ship with Fased and are read-only until copied.
- **Workspace** skills are editable under one Agent workspace.
- **Shared library** skills are reusable local skills under `~/.fased/skills`.
- **Plugin catalog** skills are downloaded only after review.
- **Plugin** skills are supplied by enabled extensions.

A skill can be installed but still not ready. For example, `blogwatcher` is
bundled, but it needs the `blogwatcher` CLI before the Agent can use it
successfully. Its install action installs the dependency, not the skill source;
it uses Go because the skill metadata declares a Go module installer. Other
skills may use npm, uv, brew, or direct download installers instead.
`bluebubbles` is also bundled, but it needs `channels.bluebubbles` account
configuration. The skill detail modal can save that root config path directly,
while **Agent > Channels** remains the fuller account setup UI. Do not paste
channel credentials into skill-local JSON unless a skill explicitly declares its
own typed config field.

Some dependency installers use Homebrew. On Linux/WSL this means Linuxbrew, and
the gateway process must have Linuxbrew's `bin` directory in `PATH`. Installing a
dependency never grants Agent access, tools, wallet actions, or mining actions.

Security boundary: a skill can teach the Agent what to do, but it does not
automatically receive tools, wallet signing, mining wallet access, channel
credentials, or task autonomy. Generic skill wallet grants are limited to the
Agent wallet role. Satcoin mining uses the dedicated Mining runtime and the
singleton `@wallet:mining` path, not arbitrary third-party skills.

## Step-by-Step: Your First Skill

In the Control UI, use **Agents > select Agent > Skills > + Skill** for the
normal path. Creating from an Agent automatically uses that Agent workspace.

1. Open **Agents**, select the Agent, then open **Agent > Skills**.
2. Click **+ Skill**.
3. Enter a short name and description.
4. Choose a starter template:
   - **General workflow**
   - **Research/review**
   - **Tool/API workflow**
   - **Wallet-safe workflow**
   - **Operational runbook**
   - **Task automation**
   - **Channel workflow**
5. Confirm the Agent workspace that should own the editable copy.
6. Click **Create skill**.
7. Open the created skill and edit `SKILL.md`.
8. Allow it on the Agent from the skill detail **Agent access** section or from
   the row toggle.

The template creates starter `SKILL.md` content only. It does not install
external binaries, configure API credentials, grant tools, grant wallets, or
enable mining. Those stay explicit in **Services**, **Agent > Tools**, and
**Wallets > Skill Grants**.

### 1. Create the Directory

Skills live in your workspace, usually `~/.fased/workspace/skills/`. Create a new folder for your skill:

```bash
mkdir -p ~/.fased/workspace/skills/hello-world
```

### 2. Define the `SKILL.md`

Create a `SKILL.md` file in that directory. This file uses YAML frontmatter for metadata and Markdown for instructions.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, reply with "Hello from your custom skill!".
```

### 3. Add Tools (Optional)

You can define custom tools in skill metadata or instruct the agent to use
existing Fased tools, such as `exec` or `browser`, when the Agent's tool policy
allows them.

### 4. Refresh Fased

Ask your agent to "refresh skills", start a new session, or restart the
gateway. Fased will discover the new directory and index the `SKILL.md`.

## Best Practices

- **Be Concise**: Instruct the model on _what_ to do, not how to be an AI.
- **Safety first**: If your skill uses `exec` or shell commands, ensure prompts
  do not allow arbitrary command injection from untrusted user input.
- **Test Locally**: Use `fased agent --message "use my new skill"` to test.

## Shared Skills

You can also browse and contribute skills through the plugin catalog.

## Wallet-capable Skills

Custom and installed skills do not receive wallet access automatically. If your
skill needs wallet actions, grant only the route it needs:

```bash
fased skills wallet grant my-skill \
  --registry https://clawhub.com \
  --actions send \
  --role agent \
  --wallet-id agent \
  --chain solana \
  --input-mint So11111111111111111111111111111111111111112 \
  --output-mint <TOKEN_MINT> \
  --max-amount 100000000
```

The grant is Agent-wallet-only. Skills cannot use Mining or Vault wallets for
generic wallet actions, and installed plugin-catalog skills must come from an
allowlisted registry origin.

If you publish the skill through the plugin catalog, Fased records requested wallet
permissions, requested tool access, and install metadata from the skill metadata
at install time. Updates that add or change risky wallet permissions, tool
access, install metadata, or new archive scan warnings are blocked until the
operator explicitly approves the permission change. Plugin archives are scanned
before install; sensitive files, native binaries, installer scripts, dependency
blocks, and dangerous source-code patterns are rejected, while dependency
manifests and helper scripts are recorded as review warnings. Operators can
review installed source and grant state with:

```bash
fased skills marketplace list
fased skills permissions <skill-id>
```
