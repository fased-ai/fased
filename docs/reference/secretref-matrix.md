---
title: "SecretRef Matrix"
summary: "Which Fased credential fields can use SecretRef, and which tools manage them"
read_when:
  - Moving credentials out of plaintext config
  - Auditing provider, skill, Google Chat, web, talk, or auth-profile secrets
  - Deciding whether to use env, file, or exec-backed secret references
---

# SecretRef Matrix

Fased supports `SecretRef` objects so credentials can stay in environment
variables, local secret files, or trusted resolver commands instead of plaintext
config.

Use this object shape:

```json5
{ source: "env" | "file" | "exec", provider: "default", id: "..." }
```

Plaintext strings still work. SecretRefs are optional, but recommended for
hosted gateways, shared machines, and credentials that are hard to rotate.

## Secret Sources

- `env`: simple local or hosted env vars.
  Example: `{ source: "env", provider: "default", id: "OPENAI_API_KEY" }`.
  The default env provider works without extra config.
- `file`: mounted JSON secret files or one-value secret files.
  Example: `{ source: "file", provider: "filemain", id: "/providers/openai/apiKey" }`.
  Configure it with `secrets.providers.filemain = { source: "file", path, mode }`.
- `exec`: 1Password, Vault, `sops`, or a custom trusted resolver.
  Example: `{ source: "exec", provider: "vault", id: "providers/openai/apiKey" }`.
  Configure it with `secrets.providers.vault = { source: "exec", command, args, passEnv }`.

Validation and runtime behavior are documented in
[Secrets Management](/gateway/secrets). In short: startup fails if a required
ref cannot resolve; reload keeps the last-known-good runtime snapshot if a new
ref fails.

## Field Matrix

### Model Providers

- `models.providers.<provider>.apiKey`
  Supports SecretRef. Managed by Agent > Models, `fased models`, and
  `fased secrets`. Use it for provider-level API keys when you do not use auth
  profiles.
- `auth-profiles.json profiles.<profileId>.keyRef`
  Supports SecretRef. Managed by Agent > Models, `fased models auth`, and
  `fased secrets`. Used by `type: "api_key"` auth profiles. Runtime ignores
  plaintext `key` when `keyRef` exists.
- `auth-profiles.json profiles.<profileId>.tokenRef`
  Supports SecretRef. Managed by Agent > Models, `fased models auth`, and
  `fased secrets`. Used by `type: "token"` auth profiles. Runtime ignores
  plaintext `token` when `tokenRef` exists.
- OAuth credential files do not use SecretRef. They are managed by the provider
  login flow, and SecretRef migration does not rewrite OAuth stores.

### Skills and Plugins

- `skills.entries.<skillKey>.apiKey`
  Resolves through the runtime snapshot before skill env injection. Managed by
  Agent > Skills and `fased secrets`. Validate with
  `fased secrets audit --check`.
- `skills.entries.<skillKey>.env`
  Has no generic SecretRef contract. Store non-secret env values here. Prefer
  `apiKey` or a skill-specific credential field for secrets.
- `plugins.entries.<pluginId>.apiKey`
  Has no stable top-level credential field. Plugin credentials belong in
  plugin-defined config.
- `plugins.entries.<pluginId>.config.*`
  May define plugin-specific credential paths. Review the plugin manifest, UI
  hints, and plugin docs.

Installing a skill or plugin does **not** grant wallet, mining, tool, or
autonomous task access. Those grants stay separate.

## Secret Proxy Boundary

SecretRef resolves credentials. The secret-proxy runtime helper is the safer
call pattern for service/tool code that needs a credential for one provider
request:

- resolve the SecretRef inside the provider call
- pass the raw secret only to the bounded callback
- return sanitized provider output
- fail if the callback result echoes the raw secret
- keep audit metadata for source, provider, id, purpose, and consumer

This is a code boundary for Fased service/tool implementations. It is not a chat
or skill prompt feature, and it does not grant Agent tool access by itself.

### Google Chat

- `channels.googlechat.serviceAccount`
  Supports inline JSON, string JSON, or SecretRef. Managed by Agent > Channels
  and `fased secrets`.
- `channels.googlechat.serviceAccountRef`
  Explicit SecretRef field. Prefer it when keeping service-account JSON out of
  config.
- `channels.googlechat.accounts.<id>.serviceAccount`
  Per-account version. Supports inline JSON, string JSON, or SecretRef.
- `channels.googlechat.accounts.<id>.serviceAccountRef`
  Per-account explicit SecretRef field.

Other channel tokens may still use env vars or focused channel setup screens.
Only use Advanced Config for channel fields that do not yet have a friendly
SecretRef form.

### Web, Fetch, and Talk Services

These fields support SecretRef and are managed from Agent > Services or
Advanced Config:

- `tools.web.search.apiKey`: Brave Search or the selected built-in/plugin search
  provider.
- `tools.web.search.exa.apiKey`: Exa search provider.
- `tools.web.search.firecrawl.apiKey`: Firecrawl search provider.
- `tools.web.search.perplexity.apiKey`: Perplexity/OpenRouter path.
- `tools.web.search.grok.apiKey`: xAI/Grok web search path.
- `tools.web.search.gemini.apiKey`: Gemini grounded search path.
- `tools.web.search.kimi.apiKey`: Moonshot/Kimi search path.
- `tools.web.search.tavily.apiKey`: Tavily search provider.
- `tools.web.fetch.firecrawl.apiKey`: Firecrawl fallback for `web_fetch`.
- `talk.apiKey`: legacy global talk API key. Prefer provider-specific talk
  config when available.
- `talk.providers.<provider>.apiKey`: provider-specific TTS credentials.

These fields are SecretRef-capable, but the `fased secrets configure/apply`
migration helper is narrower than the schema. If a field is not offered by the
helper, edit it through the focused UI or Advanced Config and run
`fased secrets audit --check`.

### Memory Search

- `agents.defaults.memorySearch.remote.apiKey`
  Runtime-tolerant. Managed by Agent > Memory, the Memory page, or Advanced
  Config. Used for custom remote embedding endpoints. Prefer provider auth/env
  keys for OpenAI, Gemini, Voyage, and Mistral when possible.
- `agents.list[].memorySearch.remote.apiKey`
  Runtime-tolerant per-Agent override. Managed by Agent > Memory or Advanced
  Config. Validate with a memory status/search check after saving.

Memory search can also resolve API keys from provider auth/config/env for common
embedding providers. See [Memory Config](/reference/memory-config).

## Tooling Coverage

- `fased secrets audit --check`: finds plaintext and unresolved refs for model
  providers, skill API keys, Google Chat service accounts, and auth-profile
  refs.
- `fased secrets configure`: builds SecretRef provider config and migration
  plans for the main supported static credential fields.
- `fased secrets apply --from <plan>`: applies a reviewed migration plan after
  preflight.
- `fased secrets reload`: re-resolves refs and swaps the runtime snapshot
  atomically.
- Control UI focused pages: best for normal setup. Use Agent > Models, Agent >
  Services, Agent > Skills, and Agent > Channels first.
- Advanced Config: escape hatch for fields that do not have a friendly form yet.

## Credential Defaults

- Prefer `env` for local installs and hosted secret managers that expose env vars.
- Prefer `file` for mounted secrets in Docker/Podman/Kubernetes-style hosting.
- Prefer `exec` only when the resolver command is trusted, absolute, reviewed,
  and has a small environment allowlist.
- Do not store wallet seed phrases, private keys, or passkeys in SecretRef
  fields. Wallet material stays in the wallet keystore/passkey flow.
- Do not assume a resolved key grants Agent access. Services connect
  credentials; Agent > Tools and Agent > Skills decide what the selected Agent
  can use.

Related docs:

- [Secrets Management](/gateway/secrets)
- [Secrets CLI](/cli/secrets)
- [Authentication](/gateway/authentication)
- [API Usage and Costs](/reference/api-usage-costs)
