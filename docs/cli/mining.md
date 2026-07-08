---
summary: "Operate SAT mining from the terminal: readiness, singleton mining wallet, capital, and commit controls."
read_when:
  - You want to operate SAT mining without using the browser UI
  - You need mining status, readiness, or wallet/capital commands from a terminal
title: "mining"
---

# `fased mining`

SAT mining command surface for terminal-first operators.

Use this when you want to inspect or operate mining without going through the browser UI.

Normal users do not need to run `fased plugins enable sat-mining` to begin
mining. That command is a lower-level plugin management/debug step. The normal
path is Mining wallet setup, readiness, capital, commit, then start.

The expected operator flow is:

1. create or import the singleton Mining wallet as `@wallet:mining`
2. check readiness
3. deposit miner capital
4. set commit
5. start mining
6. watch status and history

## What it covers

- live mining status
- readiness checks
- mining-eligible wallets
- active singleton mining-wallet assignment
- start and stop mining
- capital deposit and withdrawal
- active commit amount
- recent mining history

Recovery and claim-heavy workflows are still easier in Mining when you need
guided operator context.

For strategy tuning, planner behavior, claim policy, sweep policy, and recovery
interpretation, read [Advanced SAT mining](/plugins/crypto/mining-advanced).

## Common commands

```bash
fased mining status
fased mining readiness
fased mining wallets
fased mining start --wallet mining
fased mining deposit-capital --sol 1
fased mining set-commit --sol 0.75
fased mining claim-backlog
fased mining keeper run
fased mining stop
```

## Commands

### `fased mining status`

Show live SAT mining status and issuance state.

```bash
fased mining status
fased mining status --json
```

### `fased mining readiness`

Show whether the selected wallet is ready to mine.

```bash
fased mining readiness
fased mining readiness --wallet mining
```

Practical reading:

- if wallet selection is wrong, fix the Mining wallet setup before starting
- if signer or RPC is unhealthy, do not try to force start
- if funding or capital checks fail, fix capital before blaming the runtime

### `fased mining wallets`

List mining-eligible wallets known to the runtime.

```bash
fased mining wallets
```

### `fased mining start`

Start the SAT runtime for the active or provided wallet.

```bash
fased mining start
fased mining start --wallet mining
```

### `fased mining stop`

Stop the SAT runtime.

```bash
fased mining stop
```

Stop disables new cycle submissions. If capital is still locked in an active or
claiming cycle, recovery/drain work may continue until the runtime can clear it.

### `fased mining history`

Show recent mining history windows.

```bash
fased mining history
fased mining history --window 24h --activity-window 7d --max-points 100
```

### `fased mining claim-backlog`

Claim the oldest ready SAT reward backlog batch.

```bash
fased mining claim-backlog
fased mining claim-backlog --json
```

### `fased mining keeper run`

Run one permissionless SAT keeper/cranker settlement tick.

```bash
fased mining keeper run
fased mining keeper run --json
```

### `fased mining cleanup resolved`

Close resolved cycle accounts for a specific cycle and recover rent where the
protocol permits it.

```bash
fased mining cleanup resolved --cycle 5933700
```

### `fased mining deposit-capital`

Move SOL into miner capital.

```bash
fased mining deposit-capital --sol 1
fased mining deposit-capital --lamports 1000000000
```

### `fased mining withdraw-capital`

Withdraw SOL from miner capital.

```bash
fased mining withdraw-capital --sol 0.25
```

### `fased mining set-commit`

Set the active SAT commit amount.

```bash
fased mining set-commit --sol 0.75
fased mining set-commit --sol 0.75 --no-persist-config
```

Use `--json` for scripts. The JSON shape follows the same runtime status,
history, readiness, and recovery objects used by the browser Mining page. For
route and method details, see [SAT mining API and protocol](/plugins/crypto/mining-protocol).

## Shared options

These commands support the normal gateway RPC flags where applicable:

- `--url <url>`
- `--token <token>`
- `--timeout <ms>`
- `--expect-final`
- `--json`

## Practical rule

Use the browser mining page for the normal operator flow.
Use `fased mining` when you want:

- SSH-first operation
- scripts and automation
- fast status inspection on a VPS

Another practical rule:

- SAT mining should use a dedicated self-hosted wallet role
- the runtime expects the self-hosted signer path for unattended submission
- the mining wallet should be treated as working capital, not long-term reserve

Recommended operator loop:

1. `fased mining readiness --wallet <id>`
2. `fased mining deposit-capital --sol <amount>`
3. `fased mining set-commit --sol <amount>`
4. `fased mining start --wallet <id>`
5. `fased mining status`
6. `fased mining history`

If mining later stalls:

- inspect readiness again
- inspect history and status
- fix signer, RPC, or capital
- use the browser Mining recovery path when you need guided claim or
  blocked-state handling

## Related docs

- [Mining](/plugins/crypto/mining-page)
- [Advanced SAT mining](/plugins/crypto/mining-advanced)
- [SAT mining API and protocol](/plugins/crypto/mining-protocol)
- [Wallet](/plugins/crypto/wallet-page)
- [CLI reference](/cli)
