---
summary: "OAuth in Fased: token exchange, storage, refresh behavior, and multi-account patterns."
read_when:
  - You want to understand Fased OAuth end-to-end
  - You hit token invalidation / logout issues
  - You want setup-token or OAuth auth flows
  - You want multiple accounts or profile routing
title: "OAuth"
---

# OAuth

Fased stores model credentials as **auth profiles**. An auth profile can be:

- `oauth`: refreshable provider sign-in credentials
- `token`: static bearer token, including Anthropic `setup-token`
- `api_key`: provider API key or SecretRef-backed API key

Use this page when you need to understand sign-in, setup-token, refresh, and
multi-account routing.

Common entry points:

```bash
fased models auth login --provider openai-codex
fased models auth login --provider anthropic --method anthropic-oauth
fased models auth setup-token --provider anthropic
```

Provider plugins can also ship their own OAuth, token, device, or API-key flows.
Run them through the same command surface:

```bash
fased models auth login --provider <id> --method <method-id>
```

## Why the auth profile store exists

OAuth providers commonly mint a **new refresh token** during login or refresh.
Some providers can invalidate older refresh tokens for the same user/app.

Practical symptom: you sign in with Fased and another CLI, then one of them later
looks logged out.

Fased keeps provider credentials in `auth-profiles.json` so the runtime has one
source of truth:

- runtime reads credentials from one local store
- multiple accounts can coexist as separate profile IDs
- profile order can be managed per Agent

## Storage (where tokens live)

Secrets are stored **per-agent**:

- Auth profiles: `~/.fased/agents/<agentId>/agent/auth-profiles.json`
- Legacy compatibility file: `~/.fased/agents/<agentId>/agent/auth.json`
  (static `api_key` entries are scrubbed when discovered)

`auth-profiles.json` contains credential material or SecretRefs. The matching
`fased.json` fields `auth.profiles` and `auth.order` are metadata and routing
only.

Legacy import-only file (still supported, but not the main store):

- `~/.fased/credentials/oauth.json` (imported into `auth-profiles.json` on first use)

All of the above respect `$FASED_STATE_DIR` when a state-dir override is set.
Full reference: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

For static secret refs and runtime snapshot activation behavior, see [Secrets Management](/gateway/secrets).

## Login flows

### OAuth sign-in

`fased models auth login` runs the selected provider's auth flow:

```bash
fased models auth login --provider openai-codex
fased models auth login --provider anthropic --method anthropic-oauth
```

Local machine flow:

1. Fased opens the provider sign-in URL in the browser.
2. The provider returns an authorization code or localhost callback.
3. Fased exchanges that code for credentials.
4. Fased writes a refreshable `oauth` profile.

Remote/VPS flow:

1. Fased prints a provider URL.
2. Open it in your local browser.
3. Paste the redirect URL or authorization code back into the terminal.
4. Fased writes the same local `oauth` profile on the host.

OpenAI sign-in uses the provider route id `openai-codex`. The route name is
legacy/internal compatibility naming; the user-facing provider is OpenAI.

### Anthropic setup-token

Anthropic setup-token is stored as a `token` profile, not an OAuth profile. Run
`claude setup-token` on any machine, then paste it into Fased:

```bash
fased models auth setup-token --provider anthropic
```

If you generated the token elsewhere, paste it manually:

```bash
fased models auth paste-token --provider anthropic
```

`setup-token` writes `anthropic:manual` by default from the direct CLI command.
The onboarding wizard can ask for a token name and create a named
`anthropic:<name>` profile.

Verify:

```bash
fased models status --check
```

## Profile IDs

OAuth login profile IDs are normally based on provider and email:

- `openai-codex:user@example.com`
- `anthropic:user@example.com`

If the provider does not return an email, Fased falls back to
`provider:default`. API-key defaults usually use `provider:default`; manually
pasted tokens usually use `provider:manual` unless you choose another profile
ID.

## Refresh + expiry

OAuth and some token profiles store an `expires` timestamp.

At runtime:

- if an OAuth profile is still valid, use the stored access token
- if OAuth is expired, refresh under a file lock and overwrite the profile
- if a static token is expired, skip it; Fased does not refresh static tokens

Run this before relying on an Agent:

```bash
fased models status --check
```

## Multiple accounts (profiles) + routing

Two useful patterns:

### 1) Preferred: separate agents

If you want personal and work credentials to never interact, use isolated
agents with separate sessions, credentials, and workspaces:

```bash
fased agents add work
fased agents add personal
```

Then configure auth per-agent (wizard) and route chats to the right agent.

### 2) Advanced: multiple profiles in one agent

`auth-profiles.json` supports multiple profile IDs for the same provider. Fased
orders usable profiles like this:

1. explicit per-agent order from `auth-profiles.json`
2. configured order from `fased.json`
3. discovered profiles, sorted OAuth -> token -> API key, round-robin by last use

Pick which profile is used:

- per Agent with `fased models auth order set`
- per-session via `/model ...@<profileId>`

Examples:

```bash
fased models auth order set --provider anthropic anthropic:work anthropic:manual
```

```text
/model Opus@anthropic:work
```

How to see what profile IDs exist:

- `fased models status --json`
- Agent > Models in the Control UI

## Operational notes

- Re-authenticate when `models status --check` reports expired or missing auth.
- Keep `auth-profiles.json` local to the Agent host; do not paste it into issues
  or public logs.
- On multi-Agent setups, OAuth credentials can be synced to sibling Agent stores
  during onboarding/sign-in, but each Agent still has its own auth profile store.
- For provider rotation, cooldown, and fallback behavior, see
  [/concepts/model-failover](/concepts/model-failover).

Related docs:

- [/concepts/model-failover](/concepts/model-failover) (rotation + cooldown rules)
- [/concepts/model-providers](/concepts/model-providers) (provider setup)
- [/tools/slash-commands](/tools/slash-commands) (command surface)
