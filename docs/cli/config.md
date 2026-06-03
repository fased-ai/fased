---
summary: "Read, write, or unset Fased config values without opening the full wizard."
read_when:
  - You want to read or edit config non-interactively
title: "config"
---

# `fased config`

Use `fased config` for non-interactive config edits. It can read, write, and unset values by path. Run it without a subcommand to open the same interactive wizard as `fased configure`.

Browser equivalent: **Advanced > Config**. Use it as the raw escape hatch only
after checking the focused page that owns the setting, such as **Agent >
Models**, **Agent > Channels**, **Agent > Skills**, **Agent > Tools**, **Agent >
Services**, **Agent > Memory**, or **Logs**.

## Examples

```bash
fased config get browser.executablePath
fased config get models.providers.openai.apiKey --unredacted
fased config set browser.executablePath "/usr/bin/google-chrome"
fased config set agents.defaults.heartbeat.every "2h"
fased config set agents.defaults.taskModels.cheapCheck "openrouter/your-cheap-model"
fased config set agents.defaults.taskModels.escalation "openrouter/your-strong-model"
fased config set agents.list[0].taskModels.cheapCheck "openrouter/agent-cheap-model"
fased config set agents.list[0].taskModels.summarizer "openai/agent-summary-model"
fased config set agents.list[0].tools.exec.node "node-id-or-name"
fased config unset tools.web.search.apiKey
```

Provider onboarding only makes models available. Assign default, cheap/check,
strong, escalation, coding, and summarizer roles per Agent from Agent > Models
or with `agents.list[*].taskModels.*`. Scheduled Tasks inherit those roles
unless the Task sets an explicit model override.

## Paths

Paths use dot or bracket notation:

```bash
fased config get agents.defaults.workspace
fased config get agents.list[0].id
```

Use the agent list index to target a specific agent:

```bash
fased config get agents.list
fased config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

Values are parsed as JSON5 when possible; otherwise they are treated as strings.
For `config set`, use `--strict-json` to require JSON5 parsing. `--json` remains
supported there as a legacy alias for strict JSON parsing. For `config get`,
`--json` means JSON-formatted output.
`config get` redacts sensitive values unless `--unredacted` is passed.

```bash
fased config set agents.defaults.heartbeat.every "0m"
fased config set gateway.port 19001 --strict-json
fased config set channels.whatsapp.groups '["*"]' --strict-json
```

Use `--unredacted` only in a trusted terminal; it can print credentials and
other secrets.

Restart the gateway after edits.
