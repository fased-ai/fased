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

| Source | Use For                                                | Ref Example                                                                | Provider Config                                                        |
| ------ | ------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `env`  | Simple local or hosted env vars                        | `{ source: "env", provider: "default", id: "OPENAI_API_KEY" }`             | Optional. `default` env provider works without extra config.           |
| `file` | Mounted JSON secret files or one-value secret files    | `{ source: "file", provider: "filemain", id: "/providers/openai/apiKey" }` | `secrets.providers.filemain = { source: "file", path, mode }`          |
| `exec` | 1Password, Vault, `sops`, or a custom trusted resolver | `{ source: "exec", provider: "vault", id: "providers/openai/apiKey" }`     | `secrets.providers.vault = { source: "exec", command, args, passEnv }` |

Validation and runtime behavior are documented in
[Secrets Management](/gateway/secrets). In short: startup fails if a required
ref cannot resolve; reload keeps the last-known-good runtime snapshot if a new
ref fails.

## Field Matrix

### Model Providers

| Field                                              | Supports SecretRef | Managed By                                           | Notes                                                                                            |
| -------------------------------------------------- | ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `models.providers.<provider>.apiKey`               | Yes                | Agent > Models, `fased models`, `fased secrets`      | Use this for provider-level API keys when you do not use auth profiles.                          |
| `auth-profiles.json profiles.<profileId>.keyRef`   | Yes                | Agent > Models, `fased models auth`, `fased secrets` | Used by `type: "api_key"` auth profiles. Runtime ignores plaintext `key` when `keyRef` exists.   |
| `auth-profiles.json profiles.<profileId>.tokenRef` | Yes                | Agent > Models, `fased models auth`, `fased secrets` | Used by `type: "token"` auth profiles. Runtime ignores plaintext `token` when `tokenRef` exists. |
| OAuth credential files                             | No                 | Provider login flow                                  | OAuth credentials are separate. SecretRef migration does not rewrite OAuth stores.               |

### Skills and Plugins

| Field                                 | Supports SecretRef            | Managed By                      | Notes                                                                                                                            |
| ------------------------------------- | ----------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `skills.entries.<skillKey>.apiKey`    | Yes at runtime                | Agent > Skills, `fased secrets` | Skill `apiKey` can resolve through the runtime snapshot before skill env injection. Validate with `fased secrets audit --check`. |
| `skills.entries.<skillKey>.env`       | No generic SecretRef contract | Agent > Skills                  | Store non-secret env values here. Prefer `apiKey` or a skill-specific credential field for secrets.                              |
| `plugins.entries.<pluginId>.apiKey`   | No stable top-level field     | Extensions                      | Do not rely on a generic plugin `apiKey` field. Plugin credentials belong in plugin-defined config.                              |
| `plugins.entries.<pluginId>.config.*` | Plugin-defined                | Extensions                      | Plugin-specific config may define its own credential path. Review the plugin manifest/UI hints and plugin docs.                  |

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

| Field                                                 | Supports SecretRef | Managed By                        | Notes                                                                            |
| ----------------------------------------------------- | ------------------ | --------------------------------- | -------------------------------------------------------------------------------- |
| `channels.googlechat.serviceAccount`                  | Yes                | Agent > Channels, `fased secrets` | Can be inline JSON, string JSON, or SecretRef.                                   |
| `channels.googlechat.serviceAccountRef`               | Yes                | Agent > Channels, `fased secrets` | Explicit ref field. Prefer this when keeping service-account JSON out of config. |
| `channels.googlechat.accounts.<id>.serviceAccount`    | Yes                | Agent > Channels, `fased secrets` | Per-account version.                                                             |
| `channels.googlechat.accounts.<id>.serviceAccountRef` | Yes                | Agent > Channels, `fased secrets` | Per-account explicit ref field.                                                  |

Other channel tokens may still use env vars or focused channel setup screens.
Only use Advanced Config for channel fields that do not yet have a friendly
SecretRef form.

### Web, Fetch, and Talk Services

| Field                                | Supports SecretRef | Managed By                               | Notes                                                                            |
| ------------------------------------ | ------------------ | ---------------------------------------- | -------------------------------------------------------------------------------- |
| `tools.web.search.apiKey`            | Yes                | Agent > Services, Advanced Config        | Brave Search or the selected built-in/plugin search provider.                    |
| `tools.web.search.exa.apiKey`        | Yes                | Agent > Services, Advanced Config        | Exa search provider.                                                             |
| `tools.web.search.firecrawl.apiKey`  | Yes                | Agent > Services, Advanced Config        | Firecrawl search provider.                                                       |
| `tools.web.search.perplexity.apiKey` | Yes                | Agent > Services, Advanced Config        | Perplexity/OpenRouter path.                                                      |
| `tools.web.search.grok.apiKey`       | Yes                | Agent > Services, Advanced Config        | xAI/Grok web search path.                                                        |
| `tools.web.search.gemini.apiKey`     | Yes                | Agent > Services, Advanced Config        | Gemini grounded search path.                                                     |
| `tools.web.search.kimi.apiKey`       | Yes                | Agent > Services, Advanced Config        | Moonshot/Kimi search path.                                                       |
| `tools.web.search.tavily.apiKey`     | Yes                | Agent > Services, Advanced Config        | Tavily search provider.                                                          |
| `tools.web.fetch.firecrawl.apiKey`   | Yes                | Agent > Services, Advanced Config        | Firecrawl fallback for `web_fetch`.                                              |
| `talk.apiKey`                        | Yes                | Agent > Services / Talk, Advanced Config | Legacy global talk API key. Prefer provider-specific talk config when available. |
| `talk.providers.<provider>.apiKey`   | Yes                | Agent > Services / Talk, Advanced Config | Provider-specific TTS credentials.                                               |

These fields are SecretRef-capable, but the `fased secrets configure/apply`
migration helper is narrower than the schema. If a field is not offered by the
helper, edit it through the focused UI or Advanced Config and run
`fased secrets audit --check`.

### Memory Search

| Field                                        | Supports SecretRef | Managed By                                   | Notes                                                                                                                     |
| -------------------------------------------- | ------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `agents.defaults.memorySearch.remote.apiKey` | Runtime-tolerant   | Agent > Memory, Memory page, Advanced Config | Used for custom remote embedding endpoints. Prefer provider auth/env keys for OpenAI/Gemini/Voyage/Mistral when possible. |
| `agents.list[].memorySearch.remote.apiKey`   | Runtime-tolerant   | Agent > Memory, Advanced Config              | Per-Agent override. Validate with a memory status/search check after saving.                                              |

Memory search can also resolve API keys from provider auth/config/env for common
embedding providers. See [Memory Config](/reference/memory-config).

## Tooling Coverage

| Tool                                | Scope                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `fased secrets audit --check`       | Finds plaintext and unresolved refs for model providers, skill API keys, Google Chat service accounts, and auth-profile refs. |
| `fased secrets configure`           | Builds SecretRef provider config and migration plans for the main supported static credential fields.                         |
| `fased secrets apply --from <plan>` | Applies a reviewed migration plan after preflight.                                                                            |
| `fased secrets reload`              | Re-resolves refs and swaps the runtime snapshot atomically.                                                                   |
| Control UI focused pages            | Best for normal setup. Use Agent > Models, Agent > Services, Agent > Skills, and Agent > Channels first.                      |
| Advanced Config                     | Escape hatch for fields that do not have a friendly form yet.                                                                 |

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
