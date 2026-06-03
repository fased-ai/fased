---
name: session-memory
description: "Save session context to memory when /new or /reset command is issued"
homepage: https://docs.fased.ai/automation/hooks#session-memory
metadata:
  {
    "fased":
      {
        "emoji": "💾",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with FasedAgent" }],
      },
  }
---

# Session Memory Hook

Automatically saves session context to your workspace memory when you issue `/new` or `/reset`.

## What It Does

When you run `/new` or `/reset` to start a fresh session:

1. **Finds the previous session** - Uses the pre-reset session entry to locate the correct transcript
2. **Extracts conversation** - Reads the last N user/assistant messages from the session (default: 15, configurable)
3. **Chooses a filename slug** - Uses a timestamp by default, or an LLM-generated slug when explicitly enabled
4. **Saves to memory** - Creates a new file at `<workspace>/memory/YYYY-MM-DD-slug.md`

The save runs as background housekeeping so `/new` and `/reset` replies are not
blocked by transcript reads or optional slug generation.

## Output Format

Memory files are created with the following format:

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

## Filename Examples

By default, the hook uses a timestamp slug:

- `2026-01-16-1430.md`

If `llmSlug` is enabled, the hook can generate descriptive slugs based on your conversation:

- `2026-01-16-vendor-pitch.md` - Discussion about vendor evaluation
- `2026-01-16-api-design.md` - API architecture planning
- `2026-01-16-bug-fix.md` - Debugging session

## Requirements

- **Config**: `workspace.dir` must be set (automatically configured during onboarding)

The hook uses your configured LLM provider only when `llmSlug` is explicitly enabled.

## Configuration

The hook supports optional configuration:

| Option     | Type    | Default | Description                                                     |
| ---------- | ------- | ------- | --------------------------------------------------------------- |
| `messages` | number  | 15      | Number of user/assistant messages to include in the memory file |
| `llmSlug`  | boolean | false   | Generate descriptive filename slugs with the configured LLM     |

Example configuration:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": {
          "enabled": true,
          "messages": 25,
          "llmSlug": true
        }
      }
    }
  }
}
```

The hook automatically:

- Uses your workspace directory (`~/.fased/workspace` by default)
- Uses timestamp slugs by default
- Falls back to timestamp slugs if LLM slug generation is disabled or unavailable

## Disabling

To disable this hook:

```bash
fased hooks disable session-memory
```

Or remove it from your config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": { "enabled": false }
      }
    }
  }
}
```
