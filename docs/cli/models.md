---
summary: "Inspect models, auth state, aliases, and fallback resolution from the CLI."
read_when:
  - You want to change default models or view provider auth status
  - You want to scan available models/providers and debug auth profiles
title: "models"
---

# `fased models`

Use `fased models` to inspect model discovery, auth state, aliases, and the resolved default or fallback chain.

Browser equivalent: **Agent > Models**. Provider sign-in makes models
available; each Agent chooses its own primary, fallback, and task-role model
refs.

Related:

- Providers + models: [Models](/concepts/models)
- Provider auth setup: [Getting started](/start/getting-started)

## Common commands

```bash
fased models status
fased models list
fased models set <model-or-alias>
fased models set-image <model-or-alias>
fased models scan
```

`fased models status` shows the resolved default/fallbacks plus an auth overview.
When provider usage snapshots are available, the OAuth/token status section
includes provider usage headers.
Add `--probe` to run live auth probes against each configured provider profile.
Probes are real requests (may consume tokens and trigger rate limits).
Use `--agent <id>` to inspect a configured agent’s model/auth state. When
omitted, the command uses `FASED_AGENT_DIR`/`PI_CODING_AGENT_DIR` if set,
otherwise the configured default agent.

Notes:

- `models set <model-or-alias>` accepts `provider/model` or an alias.
- Model refs are parsed by splitting on the **first** `/`. If the model ID
  includes `/` (OpenRouter-style), include the provider prefix:
  `openrouter/moonshotai/kimi-k2`.
- If you omit the provider, Fased treats the input as an alias or a model for
  the **default provider**. That only works when there is no `/` in the model ID.

### Catalog authority and source order

`fased models list --all`, onboarding model selection, Agent model roles, Chat,
and Tasks use the same Gateway catalog:

1. An authenticated provider model endpoint is authoritative for API-key and
   local/manual routes that expose model discovery.
2. Sign-in routes use the authenticated OAuth/device runtime catalog so Fased
   does not offer a reviewed model that the signed-in account rejects.
3. Explicit `models.providers` entries are authoritative for custom models.
4. Fased's reviewed catalog supplies capability metadata and recommendation
   order. It does not become an availability fallback when authenticated
   discovery fails.

Model metadata includes availability source, capability source, retrieval date,
auth route, confidence, and recommendation rank. Local providers are discovered
from their configured server and do not receive invented placeholder models.

Provider aliases such as `z.ai` and `z-ai` normalize to the same provider key.

### `models status`

Options:

- `--json`
- `--plain`
- `--check` (exit 1=expired/missing, 2=expiring)
- `--probe` (live probe of configured auth profiles)
- `--probe-provider <name>` (probe one provider)
- `--probe-profile <id>` (repeat or comma-separated profile ids)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (configured agent id; overrides `FASED_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

### `models list`

Options:

- `--all`: show the merged full catalog.
- `--local`: filter to local models.
- `--provider <name>`: filter by provider.
- `--json`
- `--plain`

## Aliases + fallbacks

```bash
fased models aliases list
fased models fallbacks list
fased models image-fallbacks list
```

Fallback groups support `list`, `add <model>`, `remove <model>`, and `clear`.
`image-fallbacks` controls the image-model fallback list separately from text
model fallbacks.

## Auth profiles

```bash
fased models auth add
fased models auth login --provider <id>
fased models auth setup-token
fased models auth paste-token
fased models auth login-github-copilot
fased models auth order get --provider <id>
fased models auth order set --provider <id> <profile-id> [profile-id...]
fased models auth order clear --provider <id>
```

`models auth login` runs a provider plugin’s auth flow (OAuth/API key). Use
`fased plugins list` to see which providers are installed.

Notes:

- `setup-token` prompts for a setup-token value (generate it with `claude setup-token` on any machine).
- `paste-token` accepts a token string generated elsewhere or from automation.
- `auth order` sets or clears the per-Agent auth profile order for one provider.
