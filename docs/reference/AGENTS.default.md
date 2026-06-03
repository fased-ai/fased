---
title: "Workspace Instructions Reference"
summary: "How Fased seeds and uses Agent workspace instruction files"
read_when:
  - Auditing default Agent workspace files
  - Recovering or editing AGENTS.md, SOUL.md, TOOLS.md, or memory files
  - Explaining how workspace instructions differ from skills and tool access
---

# Workspace Instructions Reference

Fased stores each Agent's durable instructions in that Agent's workspace. The
default workspace is `~/.fased/workspace`; additional Agents can use their own
workspace paths.

Normal setup does **not** require copying files by hand. Onboarding and Agent
creation call the same workspace setup code and seed missing starter files:

- `AGENTS.md`: operating instructions for the Agent.
- `SOUL.md`: identity, tone, and boundaries.
- `TOOLS.md`: user notes about local tools and devices. This file is guidance
  only; it does not grant tool access.
- `IDENTITY.md`: editable Agent identity details.
- `USER.md`: user preferences and profile notes.
- `HEARTBEAT.md`: instructions for background heartbeat checks.
- `BOOTSTRAP.md`: first-run checklist for new or incomplete workspaces.
- `MEMORY.md`: canonical curated memory file.
- `memory/`: directory for daily or topic memory Markdown files.

Fased does not overwrite existing user-owned files during normal setup. If a
workspace already has `AGENTS.md`, `SOUL.md`, `TOOLS.md`, or memory files, Fased
keeps them and only creates missing starter files.

## Manual Recovery

If a workspace was damaged or you want to inspect the starter templates, use the
checked-in templates under `docs/reference/templates/`.

```bash
mkdir -p ~/.fased/workspace
cp docs/reference/templates/AGENTS.md ~/.fased/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.fased/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.fased/workspace/TOOLS.md
```

Only do this intentionally. Copying over an existing workspace file replaces
your own instructions unless you back it up first.

## Startup Context

On each run, Fased builds a system prompt from the selected Agent and workspace.
It can include concise excerpts from:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` when the workspace is new
- `MEMORY.md` and compatibility `memory.md` when present

Large files are truncated by bootstrap limits. Files under `memory/*.md` are
normally searched and read through memory tools rather than injected wholesale.

## Memory Files

Use `MEMORY.md` for durable facts, preferences, decisions, and long-lived
constraints. Fased creates this file during workspace setup.

Use `memory/YYYY-MM-DD.md` or other Markdown files under `memory/` for daily or
topic notes. Session-memory can write archive files there when enabled.

Lowercase `memory.md` is a compatibility root. Diagnostics may show it as
missing; that is not an error when `MEMORY.md` exists.

## Skills, Tools, and Services

Workspace files are not the skill library and they do not grant execution
permissions.

- **Agent > Skills** controls which skills this Agent may load. Skill
  instructions live in `SKILL.md` files.
- **Agent > Tools** controls per-Agent allow/deny policy for tool calls.
- **Agent > Services** connects credentials for APIs such as web search, GitHub,
  Gmail, and media.
- **Wallet > Skill Grants** is required before reviewed wallet-capable skills
  can use Agent wallets. Mining and vault wallets are not granted to generic
  skills.

`TOOLS.md` can document how to use a local tool, but actual access still comes
from the runtime tool catalog and Agent policy.

## Heartbeats

When heartbeat is enabled, Fased asks the Agent to read `HEARTBEAT.md` and
respond with `HEARTBEAT_OK` when no user-facing update is needed. Keep this file
short and focused on background checks.

## Channel Safety

External chat channels route to an Agent and session. Group chats and channel
rooms stay separate from direct chat sessions. Do not place secrets, private
contact data, or internal notes in workspace files that might be summarized into
public replies.

## Backup Tip

If the workspace is important, back it up in a private repository or another
encrypted backup system.

```bash
cd ~/.fased/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md MEMORY.md
git commit -m "Add Fased workspace"
```

Do not commit secrets, API keys, private channel tokens, or wallet material.
