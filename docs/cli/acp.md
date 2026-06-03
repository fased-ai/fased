---
summary: "Run the ACP bridge so IDEs and external tools can talk to a Fased gateway."
read_when:
  - Setting up ACP-based IDE integrations
  - Debugging ACP session routing to the Gateway
title: "acp"
---

# `fased acp`

Run the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) bridge against a Fased gateway.

Use this when an IDE or external ACP client should drive the same self-hosted runtime you already use from the CLI or browser UI. The command speaks ACP over stdio and forwards requests over the gateway WebSocket while keeping ACP sessions pinned to gateway session keys.

## Usage

```bash
fased acp

# Remote Gateway
fased acp --url wss://gateway-host:18789 --token <token>

# Remote Gateway (token from file)
fased acp --url wss://gateway-host:18789 --token-file ~/.fased/gateway.token

# Attach to an existing session key
fased acp --session agent:main:main

# Attach by label (must already exist)
fased acp --session-label "support inbox"

# Reset the session key before the first prompt
fased acp --session agent:main:main --reset-session
```

## ACP client (debug)

Use the built-in ACP client to sanity-check the bridge without an IDE.
It spawns the ACP bridge and lets you type prompts interactively.

```bash
fased acp client

# Point the spawned bridge at a remote Gateway
fased acp client --server-args --url wss://gateway-host:18789 --token-file ~/.fased/gateway.token

# Override the server command (default: fased)
fased acp client --server "node" --server-args fased.mjs acp --url ws://127.0.0.1:19001
```

Permission model (client debug mode):

- Auto-approval is allowlist-based and only applies to trusted core tool IDs.
- `read` auto-approval is scoped to the current working directory (`--cwd` when set).
- Unknown/non-core tool names, out-of-scope reads, and dangerous tools always require explicit prompt approval.
- Server-provided `toolCall.kind` is treated as untrusted metadata (not an authorization source).

## How to use this

Use ACP when an IDE (or other client) speaks Agent Client Protocol and you want
it to drive a Fased Gateway session.

1. Ensure the Gateway is running (local or remote).
2. Configure the Gateway target (config or flags).
3. Point your IDE to run `fased acp` over stdio.

Example config (persisted):

```bash
fased config set gateway.remote.url wss://gateway-host:18789
fased config set gateway.remote.token <token>
```

Example direct run (no config write):

```bash
fased acp --url wss://gateway-host:18789 --token <token>
# preferred for local process safety
fased acp --url wss://gateway-host:18789 --token-file ~/.fased/gateway.token
```

## Selecting agents

ACP does not pick agents directly. It routes by the Gateway session key.

Use agent-scoped session keys to target a specific agent:

```bash
fased acp --session agent:main:main
fased acp --session agent:design:main
fased acp --session agent:qa:bug-123
```

Each ACP session maps to a single Gateway session key. One agent can have many
sessions; ACP defaults to an isolated `acp:<uuid>` session unless you override
the key or label.

## Zed editor setup

Add a custom ACP agent in `~/.config/zed/settings.json` (or use Zed’s Settings UI):

```json
{
  "agent_servers": {
    "Fased ACP": {
      "type": "custom",
      "command": "fased",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

To target a specific Gateway or agent:

```json
{
  "agent_servers": {
    "Fased ACP": {
      "type": "custom",
      "command": "fased",
      "args": [
        "acp",
        "--url",
        "wss://gateway-host:18789",
        "--token",
        "<token>",
        "--session",
        "agent:design:main"
      ],
      "env": {}
    }
  }
}
```

In Zed, open the Agent panel and select “Fased ACP” to start a thread.

## Session mapping

By default, ACP sessions get an isolated Gateway session key with an `acp:` prefix.
To reuse a known session, pass a session key or label:

- `--session <key>`: use a specific Gateway session key.
- `--session-label <label>`: resolve an existing session by label.
- `--reset-session`: mint a fresh session id for that key (same key, new transcript).

If your ACP client supports metadata, you can override per session:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

Learn more about session keys at [/concepts/session](/concepts/session).

## Options

- `--url <url>`: Gateway WebSocket URL (defaults to gateway.remote.url when configured).
- `--token <token>`: Gateway auth token.
- `--token-file <path>`: read Gateway auth token from file.
- `--password <password>`: Gateway auth password.
- `--password-file <path>`: read Gateway auth password from file.
- `--session <key>`: default session key.
- `--session-label <label>`: default session label to resolve.
- `--require-existing`: fail if the session key/label does not exist.
- `--reset-session`: reset the session key before first use.
- `--no-prefix-cwd`: do not prefix prompts with the working directory.
- `--verbose, -v`: verbose logging to stderr.

Security note:

- `--token` and `--password` can be visible in local process listings on some systems.
- Prefer `--token-file`/`--password-file` or environment variables (`FASED_GATEWAY_TOKEN`, `FASED_GATEWAY_PASSWORD`).

### `acp client` options

- `--cwd <dir>`: working directory for the ACP session.
- `--server <command>`: ACP server command (default: `fased`).
- `--server-args <args...>`: extra arguments passed to the ACP server.
- `--server-verbose`: enable verbose logging on the ACP server.
- `--verbose, -v`: verbose client logging.
