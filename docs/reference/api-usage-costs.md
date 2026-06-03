---
summary: "Audit what can spend money, which keys are used, and how to view usage"
read_when:
  - You want to understand which features may call metered APIs
  - You need to audit keys, costs, and usage visibility
  - You’re explaining Usage, chat status, or provider quota reporting
title: "API Usage and Costs"
---

# API usage & costs

This doc lists **features that can invoke API keys** and where their costs show
up. It focuses on Fased features that can generate provider usage or metered API
calls.

## Where costs show up

**Usage page**

- Open **Usage** in the Control UI for the local Fased usage history.
- It aggregates model calls from chat, channels, tasks, CLI/system runs, and available run logs.
- Group by provider, model, agent, channel, task, session, or source to see where tokens were spent.
- Costs appear only when local pricing exists; otherwise rows are marked unpriced.

**Chat/session commands**

- `/status` shows the current chat session model, context estimate, and recent response token data.
- `/usage off|tokens|full` controls the optional per-response footer for the current session.
- `/usage cost` shows a local cost summary from stored usage records.

**Provider quota/status**

- `fased status --usage` and model/provider status commands can show provider quota or health windows.
- Provider quota windows are not the same thing as local token usage. Treat them as account/provider status, not billing totals.

See [Token use & costs](/reference/token-use) for details and examples.

## How keys are discovered

Fased can pick up credentials from:

- **Auth profiles** (per-agent, stored in `auth-profiles.json`).
- **Environment variables** (e.g. `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **Config** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`).
- **Skills** (`skills.entries.<name>.apiKey`) which may export keys to the skill process env.

For normal setup, use the Control UI:

- Agent > Models connects model providers and chooses this Agent's primary/fallback/task models.
- Agent > Services connects API services such as web search, GitHub, Gmail, and media.
- Agent > Skills configures skill-local values and dependency health.
- Advanced Config remains the raw escape hatch for fields that do not yet have a friendly page.

## Features that can spend keys

### 1) Core model responses (chat + tools)

Every reply or tool call uses the **current model provider** (OpenAI, Anthropic, etc). This is the
primary source of usage and cost.

See [Models](/providers/models) for pricing config and [Token use & costs](/reference/token-use) for display.

### 2) Media understanding (audio/image/video)

Inbound media can be summarized/transcribed before the reply runs. This uses model/provider APIs.

- Audio: OpenAI / Groq / Deepgram (now **auto-enabled** when keys exist).
- Image: OpenAI / Anthropic / Google.
- Video: Google.

See [Media understanding](/nodes/media-understanding).

### 3) Memory embeddings + semantic search

Semantic memory search uses **embedding APIs** when configured for remote providers:

- `memorySearch.provider = "openai"` → OpenAI embeddings
- `memorySearch.provider = "gemini"` → Gemini embeddings
- `memorySearch.provider = "voyage"` → Voyage embeddings
- `memorySearch.provider = "mistral"` → Mistral embeddings
- Optional fallback to a remote provider if local embeddings fail

You can keep it local with `memorySearch.provider = "local"` (no API usage).

See [Memory](/concepts/memory).

### 4) Web search tool (Brave / Perplexity via OpenRouter)

`web_search` uses API keys and may incur usage charges:

- **Brave Search API**: `BRAVE_API_KEY` or `tools.web.search.apiKey`
- **Perplexity** (via OpenRouter): `PERPLEXITY_API_KEY` or `OPENROUTER_API_KEY`

Brave and other search providers may offer free or trial usage, but quotas,
verification steps, and pricing can change. Check the provider dashboard before
relying on a public search route for high-volume Agents.

See [Web tools](/tools/web).

### 5) Web fetch tool (Firecrawl)

`web_fetch` can call **Firecrawl** when an API key is present:

- `FIRECRAWL_API_KEY` or `tools.web.fetch.firecrawl.apiKey`

If Firecrawl isn’t configured, the tool falls back to direct fetch + readability
without calling Firecrawl.

See [Web tools](/tools/web).

### 6) Provider usage snapshots (status/health)

Some status commands call **provider usage endpoints** to display quota windows or auth health.
These are typically low-volume calls but still hit provider APIs:

- `fased status --usage`
- `fased models status --json`

See [Models CLI](/cli/models).

### 7) Compaction safeguard summarization

The compaction safeguard can summarize session history using the **current model**, which
invokes provider APIs when it runs.

See [Session management + compaction](/reference/session-management-compaction).

### 8) Model scan / probe

`fased models scan` can probe OpenRouter models and uses `OPENROUTER_API_KEY` when
probing is enabled.

See [Models CLI](/cli/models).

### 9) Talk (speech)

Talk mode can invoke **ElevenLabs** when configured:

- `ELEVENLABS_API_KEY` or `talk.apiKey`

See [Talk mode](/nodes/talk).

### 10) Skills (third-party APIs)

Skills can store `apiKey` in `skills.entries.<name>.apiKey`. If a skill uses that key for external
APIs, it can incur costs according to the skill’s provider.

See [Skills](/tools/skills).
