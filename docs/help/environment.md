---
summary: "Where Fased loads environment variables and the precedence order"
read_when:
  - You need to know which env vars are loaded, and in what order
  - You are debugging missing API keys in the Gateway
  - You are documenting provider auth or deployment environments
title: "Environment Variables"
---

# Environment variables

Fased pulls environment variables from multiple sources. The rule is **never
override existing values**.

## Precedence (highest → lowest)

1. **Process environment**: what the Gateway process already has from the parent
   shell or daemon.
2. **`.env` in the current working directory** (dotenv default; does not override).
3. **Global `.env`** at `~/.fased/.env`, also known as
   `$FASED_STATE_DIR/.env`; does not override.
4. **Config `env` block** in `~/.fased/fased.json` (applied only if missing).
5. **Optional login-shell import**: `env.shellEnv.enabled` or
   `FASED_LOAD_SHELL_ENV=1`, applied only for missing expected keys.

If the config file is missing entirely, step 4 is skipped. Shell import still
runs if enabled.

## Config `env` block

Two equivalent ways to set inline env vars (both are non-overriding):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## Shell env import

`env.shellEnv` runs your login shell and imports only **missing** expected keys:

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Env var equivalents:

- `FASED_LOAD_SHELL_ENV=1`
- `FASED_SHELL_ENV_TIMEOUT_MS=15000`

## Env var substitution in config

You can reference env vars directly in config string values using
`${VAR_NAME}` syntax:

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

See
[Configuration: Env var substitution](/gateway/configuration#env-var-substitution-in-config)
for full details.

## Secret refs vs `${ENV}` strings

Fased supports two env-driven patterns:

- `${VAR}` string substitution in config values.
- SecretRef objects (`{ source: "env", provider: "default", id: "VAR" }`) for
  fields that support secrets references.

Both resolve from process env at activation time. SecretRef details are
documented in [Secrets Management](/gateway/secrets).

## Path-related env vars

- `FASED_HOME`: overrides the home directory used for internal path resolution,
  including `~/.fased/`, agent dirs, sessions, and credentials. Useful for a
  dedicated service user.
- `FASED_PROFILE`: selects a named profile. The dev profile uses isolated state
  under `~/.fased-dev` and shifts the gateway port.
- `FASED_STATE_DIR`: overrides the state directory. Default: `~/.fased`.
- `FASED_CONFIG_PATH`: overrides the config file path. Default:
  `~/.fased/fased.json`.

## Logging

- `FASED_LOG_LEVEL`: overrides log level for both file and console, for example
  `debug` or `trace`. It takes precedence over `logging.level` and
  `logging.consoleLevel` in config. Invalid values are ignored with a warning.

### `FASED_HOME`

When set, `FASED_HOME` replaces the system home directory (`$HOME` /
`os.homedir()`) for all internal path resolution. This enables full filesystem
isolation for headless service accounts.

**Precedence:** `FASED_HOME` > `$HOME` > `USERPROFILE` > `os.homedir()`

**Example** (macOS LaunchDaemon):

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>FASED_HOME</key>
  <string>/Users/kira</string>
</dict>
```

`FASED_HOME` can also be set to a tilde path, such as `~/svc`. Fased expands it
using `$HOME` before use.

## Related

- [Gateway configuration](/gateway/configuration)
- [FAQ: env vars and .env loading](/help/faq#env-vars-and-env-loading)
- [Models overview](/concepts/models)
