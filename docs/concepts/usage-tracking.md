---
summary: "Usage and quota tracking surfaces, requirements, and limitations in Fased."
read_when:
  - You are wiring provider usage/quota surfaces
  - You need to explain usage tracking behavior or auth requirements
title: "Usage Tracking"
---

# Usage tracking

## What it is

- A local model usage history for calls made by Fased.
- Aggregates chat, channel, task, CLI/system, and worker/subagent runs when usage records exist.
- Groups by provider, model, Agent, channel, task, session, and source.
- Shows input, output, cache read/write, total tokens, and cost when pricing exists.
- Marks usage as unpriced when pricing is unknown instead of hiding the record.

Provider account quota/status is separate from local token accounting. The
usage page should not treat a session context snapshot as billing truth when a
transcript or task run-log usage record is available.

## Where it shows up

- **Usage** page (`/usage`): seven-day local usage history with filters for all
  Agents or a selected Agent.
- **Dashboard** (`/dash`): compact seven-day token widget.
- Agent Setup: compact Usage card for the selected Agent.
- `/status` in chats: status card with session tokens and estimated local cost
  when pricing exists. Provider usage shows for the **current model provider**
  when available.
- `/usage off|tokens|full` in chats: per-response usage footer (OAuth shows tokens only).
- `/usage cost` in chats: local cost summary aggregated from Fased session logs.
- CLI: `fased status --usage` prints a full per-provider breakdown.
- macOS menu bar: “Usage” section under Context (only if available).

## Providers + credentials

- **Anthropic (Claude)**: OAuth tokens in auth profiles.
- **GitHub Copilot**: OAuth tokens in auth profiles.
- **Gemini CLI**: OAuth tokens in auth profiles.
- **OpenAI sign-in**: OAuth tokens in auth profiles (accountId used when present).
- **MiniMax**: API key (`MINIMAX_CODE_PLAN_KEY` or `MINIMAX_API_KEY`); coding
  plan usage uses the provider's coding-plan window when available.
- **Xiaomi**: API key when configured; provider quota surfaces may be empty.
- **z.ai**: API key via env/config/auth store.

Provider quota/status is unavailable if no matching OAuth/API credentials
exist. Local usage history still comes from Fased session/task logs when those
records exist.

Use **Usage** for local token accounting. Use provider auth/status surfaces for
provider quota or account health. Use **Advanced > Debug** only when you need
raw model/provider status snapshots behind the friendly usage view.
