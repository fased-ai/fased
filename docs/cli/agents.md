---
summary: "Manage configured agents, their workspaces, identities, and routing bindings."
read_when:
  - You want multiple isolated agents (workspaces + routing + auth)
title: "agents"
---

# `fased agents`

Manage isolated agents, including their workspaces, identities, and inbound routing bindings.

Normal browser setup is **Agents > select Agent**. Use the Agent workbench tabs
for day-to-day setup:

- **Setup** for summary cards and identity/workspace/avatar.
- **Models** for provider auth and this Agent's model refs.
- **Channels** for chat account setup and route assignment.
- **Skills** for plugin-catalog review/install, create/edit/config, dependency install,
  and per-Agent skill access.
- **Tools** for per-Agent tool allow/deny.
- **Memory** for session archive and per-Agent memory diagnostics.
- **Sessions**, **Tasks**, and **Coordination** for conversation context,
  scheduled work, and multi-Agent evidence.
- **Services** for API connectors in the selected Agent context.

The CLI is for scripting, migration, and explicit routing/identity operations.

Related:

- Multi-agent routing: [Multi-Agent Routing](/concepts/multi-agent)
- Agent workspace: [Agent workspace](/concepts/agent-workspace)

## Examples

```bash
fased agents list
fased agents add work --workspace ~/.fased/workspace-work
fased agents bindings
fased agents bind --agent work --bind telegram:ops
fased agents unbind --agent work --bind telegram:ops
fased agents set-identity --workspace ~/.fased/workspace --from-identity
fased agents set-identity --agent main --avatar avatars/fased.png
fased agents delete work
fased agents delete work --force
```

## Routing bindings

Use routing bindings to pin inbound channel traffic to a specific agent.

List bindings:

```bash
fased agents bindings
fased agents bindings --agent work
fased agents bindings --json
```

Add bindings:

```bash
fased agents bind --agent work --bind telegram:ops --bind discord:guild-a
```

If you omit `accountId` (`--bind <channel>`), Fased resolves it from channel defaults and plugin setup hooks when available.

### Binding scope behavior

- A binding without `accountId` matches the channel default account only.
- `accountId: "*"` is the channel-wide fallback (all accounts) and is less specific than an explicit account binding.
- If the same agent already has a matching channel binding without `accountId`, and you later bind with an explicit or resolved `accountId`, Fased upgrades that existing binding in place instead of adding a duplicate.

Example:

```bash
# initial channel-only binding
fased agents bind --agent work --bind telegram

# later upgrade to account-scoped binding
fased agents bind --agent work --bind telegram:ops
```

After the upgrade, routing for that binding is scoped to `telegram:ops`. If you also want default-account routing, add it explicitly (for example `--bind telegram:default`).

Remove bindings:

```bash
fased agents unbind --agent work --bind telegram:ops
fased agents unbind --agent work --all
```

## Delete agents

`delete` removes the configured agent entry and prunes its state/workspace where
the command policy allows it. Without `--force`, the CLI asks for confirmation.

```bash
fased agents delete work
fased agents delete work --force --json
```

## Identity files

Each agent workspace can include an `IDENTITY.md` at the workspace root:

- Example path: `~/.fased/workspace/IDENTITY.md`
- `set-identity --from-identity` reads from the workspace root (or an explicit `--identity-file`)

Avatar paths resolve relative to the workspace root.

## Set identity

`set-identity` writes fields into `agents.list[].identity`:

- `name`
- `theme`
- `emoji`
- `avatar` (workspace-relative path, http(s) URL, or data URI)

Load from `IDENTITY.md`:

```bash
fased agents set-identity --workspace ~/.fased/workspace --from-identity
```

Override fields explicitly:

```bash
fased agents set-identity --agent main --name "Fased" --emoji "" --avatar avatars/fased.png
```

Config sample:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "Fased",
          theme: "",
          emoji: "",
          avatar: "avatars/fased.png",
        },
      },
    ],
  },
}
```
