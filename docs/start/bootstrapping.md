---
summary: "Agent bootstrapping ritual that seeds the workspace and identity files"
read_when:
  - Understanding what happens on the first agent run
  - Explaining where bootstrapping files live
  - Debugging onboarding identity setup
title: "Agent Bootstrapping"
sidebarTitle: "Bootstrapping"
---

# Agent Bootstrapping

Bootstrapping is the **first‑run** ritual that prepares an agent workspace and
collects identity details. It happens after onboarding, when the agent starts
for the first time.

## What bootstrapping does

On the first agent run, Fased bootstraps the workspace (default
`~/.fased/workspace`):

- Seeds `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`,
  `HEARTBEAT.md`, `MEMORY.md`, and `memory/`.
- Seeds `BOOTSTRAP.md` only for a brand-new workspace that has not already
  completed onboarding.
- Runs a short Q&A ritual (one question at a time).
- Writes identity + preferences to `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Removes `BOOTSTRAP.md` when finished so it only runs once.

The canonical memory file is uppercase `MEMORY.md`. A lowercase `memory.md` can
be loaded as a legacy/alternate memory root when present, but it is not the
default file.

## Where it runs

Bootstrapping always runs on the **gateway host**. If the macOS app connects to
a remote Gateway, the workspace and bootstrapping files live on that remote
machine.

<Note>
When the Gateway runs on another machine, edit workspace files on the gateway
host (for example, `user@gateway-host:~/.fased/workspace`).
</Note>

## Related docs

- macOS app onboarding: [Onboarding](/start/onboarding)
- Workspace layout: [Agent workspace](/concepts/agent-workspace)
