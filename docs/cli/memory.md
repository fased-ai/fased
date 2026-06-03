---
summary: "Inspect memory readiness, index content, and semantic search from the CLI."
read_when:
  - You want to index or search semantic memory
  - You’re debugging memory availability or indexing
title: "memory"
---

# `fased memory`

Manage semantic memory indexing and search from the terminal.
Provided by the active memory plugin (default: `memory-core`; set `plugins.slots.memory = "none"` to disable).

Browser equivalent: **Agent > Memory** for the selected Agent's session-memory,
workspace roots, backend, QMD state, and validation. Memory repair preview and
gated execution live in **Advanced > Debug**.

Related:

- Memory concept: [Memory](/concepts/memory)
- Memory Doctor: [Memory Doctor](/concepts/memory-doctor)
- Plugins: [Plugins](/tools/plugin)

## Examples

```bash
fased memory status
fased memory status --json
fased memory status --deep
fased memory status --deep --index
fased memory status --deep --index --verbose
fased memory doctor
fased memory doctor --json
fased memory index
fased memory index --verbose
fased memory search "release checklist"
fased memory search --query "release checklist"
fased memory status --agent main
fased memory index --agent main --verbose
fased memory repair execute --proposal-id memory-repair-preview-1 --yes
```

## Options

Common:

- `--agent <id>`: scope to a single agent.
- `--verbose`: emit detailed logs during probes and indexing.

Defaults by command:

- `memory doctor`: all configured agents when `--agent` is omitted.
- `memory status`, `memory index`, `memory search`, and `memory repair execute`:
  the default Agent when `--agent` is omitted.

`memory index`:

- `--force`: force a full reindex.

`memory status`:

- `--json`: print machine-readable status.

`memory search`:

- Query input: pass either positional `[query]` or `--query <text>`.
- If both are provided, `--query` wins.
- If neither is provided, the command exits with an error.
- `--max-results <n>`: cap returned results.
- `--min-score <n>`: filter lower-scoring results.
- `--json`: print machine-readable search results.

`memory repair execute`:

- `--proposal-id <id>`: proposal id to execute; repeat for multiple proposals.
- `--execution-id <id>`: optional idempotency/audit id.
- `--yes`: required confirmation for write-capable repairs.
- `--json`: print machine-readable execution result.

Notes:

- `memory status --deep` probes vector + embedding availability.
- `memory status --deep --index` runs a reindex if the store is dirty.
- `memory doctor` is read-only. It reports inventory, validation findings, and
  dry-run repair proposals.
- `memory repair execute --proposal-id <id> --yes` executes selected supported
  Memory Doctor repairs with backup, audit, rollback, and file-system safety
  gates.
- `memory index --verbose` prints per-phase details (provider, model, sources, batch activity).
- `memory status` includes any extra paths configured via `memorySearch.extraPaths`.

## Memory Doctor

`fased memory doctor` is the CLI surface for the read-only Memory Doctor
diagnostic flow:

```bash
fased memory doctor
fased memory doctor --agent main
fased memory doctor --json
```

It prints:

- workspace memory roots and backend state
- QMD and session-memory path state
- active memory plugin state
- validation error/warning/info counts
- dry-run repair proposals and blocked reasons

The `doctor` command has no `--apply`, `--repair`, or `--execute` mode. `--json`
returns the same read-only report for automation; it may include path metadata,
but not transcript bodies.

`--json` uses this read-only envelope:

```json
{
  "reports": [
    {
      "agentId": "main",
      "inventory": {},
      "validation": {},
      "repairPreview": {}
    }
  ]
}
```

`reports[].inventory`, `reports[].validation`, and
`reports[].repairPreview` are the same data used by the text output and
Advanced > Debug diagnostics. The JSON output does not include a repair executor,
gateway method, route, request params, token, confirmation, backup path, audit
path, rollback path, or any write-capable action.

Repair execution is intentionally a separate write-capable command:

```bash
fased memory repair execute --proposal-id memory-repair-preview-1 --yes
fased memory repair execute --proposal-id a --proposal-id b --execution-id repair-2026-06-01 --yes --json
```

The execute command requires `--yes` and one or more `--proposal-id` values. It
uses the same Memory Doctor preview, audit-plan fingerprint, lock/idempotency,
path-safety, backup, audit, and rollback gates as the gateway executor. It does
not run from `fased memory doctor`, and it does not read transcript bodies.

See [Memory Doctor](/concepts/memory-doctor) for the full execution boundary.
