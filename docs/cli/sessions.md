---
summary: "List stored sessions and inspect recent conversation activity."
read_when:
  - You want to list stored sessions and see recent activity
title: "sessions"
---

# `fased sessions`

List stored conversation sessions across one agent or all configured agent stores.

Sessions are the durable context layer under Agents. They can own scheduled
tasks, model overrides, token usage, delivery hints, and transcript metadata.
For the full model, see [Agents, Sessions, And Tasks](/concepts/agents-sessions-tasks).

```bash
fased sessions
fased sessions --agent work
fased sessions --all-agents
fased sessions --active 120
fased sessions --store ./tmp/sessions.json
fased sessions --verbose
fased sessions --json
```

Scope selection:

- default: configured default agent store
- `--agent <id>`: one configured agent store
- `--all-agents`: aggregate all configured agent stores
- `--store <path>`: explicit store path (cannot be combined with `--agent` or `--all-agents`)

JSON examples:

`fased sessions --all-agents --json`:

```json
{
  "path": null,
  "stores": [
    { "agentId": "main", "path": "/home/user/.fased/agents/main/sessions/sessions.json" },
    { "agentId": "work", "path": "/home/user/.fased/agents/work/sessions/sessions.json" }
  ],
  "allAgents": true,
  "count": 2,
  "activeMinutes": null,
  "sessions": [
    { "agentId": "main", "key": "agent:main:main", "model": "gpt-5" },
    { "agentId": "work", "key": "agent:work:main", "model": "claude-opus-4-5" }
  ]
}
```

## Cleanup maintenance

Run maintenance now (instead of waiting for the next write cycle):

```bash
fased sessions cleanup --dry-run
fased sessions cleanup --dry-run --fix-missing
fased sessions cleanup --agent work --dry-run
fased sessions cleanup --all-agents --dry-run
fased sessions cleanup --enforce
fased sessions cleanup --enforce --active-key "agent:main:telegram:dm:123"
fased sessions cleanup --json
```

`fased sessions cleanup` uses `session.maintenance` settings from config:

- Scope note: `fased sessions cleanup` maintains session stores/transcripts
  only. It does not prune task activity logs (`cron/runs/<jobId>.jsonl`).
  Those are managed by `cron.runLog.maxBytes` and `cron.runLog.keepLines`, as
  explained in [Task configuration](/automation/cron-jobs#configuration) and
  [Task maintenance](/automation/cron-jobs#maintenance).

- `--dry-run`: preview how many entries would be pruned/capped without writing.
  - In text mode, dry-run prints a per-session action table so you can see what
    would be kept vs removed.
- `--fix-missing`: also remove store entries whose transcript files are
  missing. Use it with `--dry-run` first.
- `--enforce`: apply maintenance even when `session.maintenance.mode` is `warn`.
- `--active-key <key>`: protect a specific active key from disk-budget eviction.
- `--agent <id>`: run cleanup for one configured agent store.
- `--all-agents`: run cleanup for all configured agent stores.
- `--store <path>`: run against a specific `sessions.json` file.
- `--json`: print a JSON summary. With `--all-agents`, output includes one
  summary per store.

`fased sessions cleanup --all-agents --dry-run --json`:

```json
{
  "allAgents": true,
  "mode": "warn",
  "dryRun": true,
  "stores": [
    {
      "agentId": "main",
      "storePath": "/home/user/.fased/agents/main/sessions/sessions.json",
      "beforeCount": 120,
      "afterCount": 80,
      "pruned": 40,
      "capped": 0
    },
    {
      "agentId": "work",
      "storePath": "/home/user/.fased/agents/work/sessions/sessions.json",
      "beforeCount": 18,
      "afterCount": 18,
      "pruned": 0,
      "capped": 0
    }
  ]
}
```

Related:

- Session config: [Configuration reference](/gateway/configuration-reference#session)
- Session/task ownership: [Agents, Sessions, And Tasks](/concepts/agents-sessions-tasks)
