---
summary: "Strict config validation + doctor-only migrations"
read_when:
  - Designing or implementing config validation behavior
  - Working on config migrations or doctor workflows
  - Handling plugin config schemas or plugin load gating
title: "Strict Config Validation"
---

# Strict Config Validation Target Plan

## Status

Partially implemented target design. Fased already has schema validation, Doctor
repair flows, plugin allowlist warnings, and stricter UI surfaces, but current
runtime code still keeps selected compatibility aliases and Doctor migrations.
Treat this page as implementation direction, not current operator behavior. For
current setup and recovery commands, use the operator docs below.

Current operator docs:

- [Gateway configuration](/gateway/configuration)
- [Configuration reference](/gateway/configuration-reference)
- [Doctor](/gateway/doctor)
- [Advanced diagnostics](/debug)

## Target goals

- **Reject unknown config keys everywhere** (root + nested), except root `$schema` metadata.
- **Reject plugin config without a schema**; don’t load that plugin.
- **Remove legacy auto-migration on load**; migrations run via doctor only.
- **Auto-run doctor (dry-run) on startup**; if invalid, block non-diagnostic commands.

## Target non-goals

- Backward compatibility on load (legacy keys do not auto-migrate).
- Silent drops of unrecognized keys.

## Strict validation rules

- Config must match the schema exactly at every level.
- Unknown keys are validation errors (no passthrough at root or nested), except root `$schema` when it is a string.
- `plugins.entries.<id>.config` must be validated by the plugin’s schema.
  - If a plugin lacks a schema, **reject plugin load** and surface a clear error.
- Unknown `channels.<id>` keys are errors unless a plugin manifest declares the channel id.
- Plugin manifests (`fased.plugin.json`) are required for all plugins.

## Plugin schema enforcement

- Each plugin provides a strict JSON Schema for its config (inline in the manifest).
- Plugin load flow:
  1. Resolve plugin manifest + schema (`fased.plugin.json`).
  2. Validate config against the schema.
  3. If missing schema or invalid config: block plugin load, record error.
- Error message includes:
  - Plugin id
  - Reason (missing schema / invalid config)
  - Path(s) that failed validation
- Disabled plugins keep their config, but Doctor + logs surface a warning.

## Doctor flow

- Target behavior: Doctor dry-run runs when config is loaded.
- Current behavior: Doctor and targeted repair flows are available, and selected
  startup/config paths surface warnings instead of silently loading unsafe state.
- If config invalid:
  - Print a summary + actionable errors.
  - Instruct: `fased doctor --fix`.
- `fased doctor --fix`:
  - Applies migrations.
  - Removes unknown keys.
  - Writes updated config.

## Target command gating (when config is invalid)

This section describes the desired end state, not the current CLI contract.

Allowed (diagnostic-only):

- `fased doctor`
- `fased logs`
- `fased health`
- `fased help`
- `fased status`
- `fased gateway status`

Everything else must hard-fail with: “Config invalid. Run `fased doctor --fix`.”

## Error UX format

- Single summary header.
- Grouped sections:
  - Unknown keys (full paths)
  - Legacy keys / migrations needed
  - Plugin load failures (plugin id + reason + path)

## Implementation touchpoints

- `src/config/zod-schema.ts`: remove root passthrough; strict objects everywhere.
- `src/config/zod-schema.providers.ts`: ensure strict channel schemas.
- `src/config/validation.ts`: fail on unknown keys; do not apply legacy migrations.
- `src/config/io.ts`: remove legacy auto-migrations; always run doctor dry-run.
- `src/config/legacy*.ts`: move usage to doctor only.
- `src/plugins/*`: add schema registry + gating.
- CLI command gating in `src/cli`.

## Tests

- Unknown key rejection (root + nested).
- Plugin missing schema → plugin load blocked with clear error.
- Invalid config → gateway startup blocked except diagnostic commands.
- Doctor dry-run auto; `doctor --fix` writes corrected config.
