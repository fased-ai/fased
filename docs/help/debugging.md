---
summary: "Debugging workflows for runtime, wallet, mining, Fased Network, and raw model streams."
read_when:
  - You need to inspect raw model output for reasoning leakage
  - You want to run the Gateway in watch mode while iterating
  - You need a repeatable debugging workflow
title: "Debugging"
---

# Debugging

This page covers debugging helpers for runtime behavior, wallet and SAT state,
and raw model streams.

For the browser operator surfaces, start with [Diagnostics](/diagnostics/index):

- **Logs** for live gateway log tail, filters, auto-follow, and export.
- **Usage** for local token accounting by Agent, provider, model, session, task,
  channel/source, and cache tokens.
- **Advanced > Debug** for status snapshots, plugin runtime diagnostics, memory
  repair preview, provider catalog checks, event log, and raw RPC inspection.
- **Advanced > Nodes** for paired device/runtime diagnostics.

Do normal setup in focused pages first: **Agent > Models**, **Agent >
Channels**, **Agent > Skills**, **Agent > Tools**, **Agent > Services**, and
**Agent > Memory**.

## Runtime debug overrides

Use `/debug` in chat to set **runtime-only** config overrides (memory, not disk).
This is different from **Advanced > Debug** in the Control UI. `/debug` changes
the current runtime override state; **Advanced > Debug** is an operator
diagnostics surface. `/debug` is disabled by default; enable with
`commands.debug: true`.
This is handy when you need to toggle obscure settings without editing `fased.json`.

Examples:

```
/debug show
/debug set messages.responsePrefix="[fased]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` clears all overrides and returns to the on-disk config.

## Wallet, SAT, and Fased Network debugging

When the problem is Wallet, Mining, or Fased Network, start with snapshots before
you click around in the UI.

```bash
fased wallet status --json
fased wallet signer doctor --json
fased mining readiness --wallet mining
fased mining status --json
fased federation status --json
fased federation bond-wallet status --json
fased logs --follow
```

Read those outputs in this order:

1. wallet provider, custody, and policy status
2. signer health and socket reachability
3. mining readiness blockers
4. live mining capital, commit, cycle, and gap state
5. Fased Network token, trust, hosted, and route state
6. bond-wallet assignment

Practical reading:

- if signer doctor fails, fix signer first
- if mining readiness fails, do not treat the problem as a Fased Network issue yet
- if Fased Network is orange after unlock, check bond state before chasing route bugs
- if the bond Vault is wrong, fix the assignment before topping up or proving

Use the full operator guides when you need the product meaning behind those
states:

- [Wallet](/plugins/crypto/wallet-page)
- [Self-hosted wallet signer](/plugins/crypto/wallet-self-hosted)
- [Mining](/plugins/crypto/mining-page)
- [Fased Network](/start/federation)
- [Bond operator](/start/bond-operator-economy)

## Capture evidence before changing state

For wallet and SAT bugs, the best report usually includes:

- `fased status --all`
- `fased wallet status --json`
- `fased wallet signer doctor --json`
- `fased mining status --json`
- `fased federation status --json`
- the exact UI action that failed

That gives you a before-state snapshot before retries, unlock changes, or manual
recoveries mutate the situation.

## Gateway watch mode

For fast iteration, run the gateway under the file watcher:

```bash
pnpm gateway:watch
```

This maps to:

```bash
node --watch-path src --watch-path tsconfig.json --watch-path package.json --watch-preserve-output scripts/run-node.mjs gateway --force
```

Add any gateway CLI flags after `gateway:watch` and they will be passed through
on each restart.

## Local rebuild notes

Use `pnpm build:fast` for normal local rebuilds while the gateway may still be
running. It keeps existing hashed `dist` chunks in place so in-flight scheduled
tasks do not import a chunk that was deleted during the rebuild.

Use `pnpm build:fast:clean` only when the gateway is stopped or as part of a
controlled restart/update flow. The clean build removes stale chunks and can
break a live process that is still importing old hashed files.

## Dev profile + dev gateway (--dev)

Use the dev profile to isolate state and spin up a disposable setup for
debugging. There are **two** `--dev` flags:

- **Global `--dev` (profile):** isolates state under `~/.fased-dev` and
  defaults the gateway port to `19001` (derived ports shift with it).
- **`gateway --dev`: tells the Gateway to auto-create a default config +
  workspace** when missing (and skip BOOTSTRAP.md).

Recommended flow (dev profile + dev bootstrap):

```bash
pnpm gateway:dev
FASED_PROFILE=dev fased tui
```

If `fased` is missing from a source checkout, run `./install.sh --no-onboard`
once to install the CLI.

What this does:

1. **Profile isolation** (global `--dev`)
   - `FASED_PROFILE=dev`
   - `FASED_STATE_DIR=~/.fased-dev`
   - `FASED_CONFIG_PATH=~/.fased-dev/fased.json`
   - `FASED_GATEWAY_PORT=19001` (browser/canvas shift accordingly)

2. **Dev bootstrap** (`gateway --dev`)
   - Writes a minimal config if missing (`gateway.mode=local`, bind loopback).
   - Sets `agent.workspace` to the dev workspace.
   - Sets `agent.skipBootstrap=true` (no BOOTSTRAP.md).
   - Seeds the workspace files if missing:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Uses the dev identity seeded into `IDENTITY.md`; edit that file or the Agent overview identity card when you need a custom dev Agent identity.
   - Skips channel providers in dev mode (`FASED_SKIP_CHANNELS=1`).

Reset flow (fresh start):

```bash
pnpm gateway:dev:reset
```

Note: `--dev` is a **global** profile flag and gets eaten by some runners.
If you need to spell it out, use the env var form:

```bash
FASED_PROFILE=dev fased gateway --dev --reset
```

`--reset` wipes config, credentials, sessions, and the dev workspace (using
`trash`, not `rm`), then recreates the default dev setup.

Tip: if a non‑dev gateway is already running (launchd/systemd), stop it first:

```bash
fased gateway stop
```

## Raw stream logging (Fased)

Fased can log the **raw assistant stream** before any filtering/formatting.
This is the best way to see whether reasoning is arriving as plain text deltas
(or as separate thinking blocks).

Use normal **Logs** first. Enable raw stream logging only when you are debugging
provider stream parsing or reasoning leakage.

Enable it via CLI:

```bash
pnpm gateway:watch --raw-stream
```

Optional path override:

```bash
pnpm gateway:watch --raw-stream --raw-stream-path ~/.fased/logs/raw-stream.jsonl
```

Equivalent env vars:

```bash
FASED_RAW_STREAM=1
FASED_RAW_STREAM_PATH=~/.fased/logs/raw-stream.jsonl
```

Default file:

`~/.fased/logs/raw-stream.jsonl`

## Sharing notes

- Raw stream logs can include full prompts, tool output, and user data.
- Keep logs local and delete them after debugging.
- If you share logs, scrub secrets and PII first.
- For routine support, prefer redacted **Logs**, `fased status --all`, and the
  focused page state over raw stream dumps.
