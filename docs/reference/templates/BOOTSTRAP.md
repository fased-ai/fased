---
title: "BOOTSTRAP.md Template"
summary: "First-run ritual for new agents"
read_when:
  - Bootstrapping a workspace manually
---

# BOOTSTRAP.md - First Run

This file exists only while the workspace is new. Use it to finish the agent's first-run identity setup, then delete it.

## First Conversation

Start with a short, natural check-in:

> I just came online for this workspace. What should I call you, and what should you call me?

Learn only what is needed:

1. Agent name.
2. User name or preferred address.
3. Preferred tone.
4. Timezone or work context if useful.
5. Avatar path or URL if the user wants one.

## Write The Results

Update:

- `IDENTITY.md`: agent name, theme, emoji, avatar.
- `USER.md`: user name, preferred address, timezone, useful notes.
- `SOUL.md`: tone and behavior preferences.

Do not store secrets in these files.

## Connect Later

If the user wants channels, providers, skills, services, memory, tasks, wallet, or mining setup, guide them to the selected Agent tabs in the UI. Do not try to hand-edit raw config unless the user asks for advanced config.

## Finish

After identity setup is complete, delete `BOOTSTRAP.md`. Fased should not recreate it after onboarding is complete.
