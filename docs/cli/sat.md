---
summary: "Run advanced SAT protocol operator maintenance from the CLI."
read_when:
  - You operate a SAT-enabled Fased runtime from a terminal
  - You need the advanced protocol maintenance command surface
title: "sat"
---

# `fased sat`

Advanced SAT protocol operator tools.

Most SAT miners should use [Mining](/cli/mining) or the browser Mining page. Use
`fased sat` only when you are running operator maintenance against a configured
gateway and understand the SAT wallet, signer, and RPC setup already in place.

## Command

### `fased sat sync-mainnet`

Fetch the official SAT mainnet manifest, verify its checksum and signature, and
apply the verified program IDs only when the manifest is live.

```bash
fased sat sync-mainnet
fased sat sync-mainnet --json
```

Before launch, a valid `not_live` response is expected and does not activate
mainnet mining. Normal users can perform the same action from **Mining > Sync**.
Do not paste program IDs from chat or use `--manifest-url` unless following an
official diagnostic runbook.

### `fased sat maintain`

Run one SAT protocol maintenance pass through the gateway.

```bash
fased sat maintain --json
fased sat maintain --target-reserve-sol 1 --json
fased sat maintain --min-sol 0.01 --min-sat-raw 100000000000
fased sat maintain --cleanup-max-cycles 3 --cleanup-budget-ms 20000 --cleanup-max-transactions 2
fased sat maintain --cleanup-batch-mode auto --cleanup-max-batch-instructions 4 --json
fased sat maintain --status-mode compact --cleanup-scan-mode recent --json
```

Loop mode is available for operators who want a local periodic runner:

```bash
fased sat maintain \
  --loop \
  --interval-seconds 300 \
  --jitter-seconds 30 \
  --log-file ~/.fased/sat-maintainer.jsonl
```

## Options

- `--target-reserve-sol <amount>` or `--target-reserve-lamports <amount>`
- `--min-sol <amount>` or `--min-sol-lamports <amount>`
- `--min-sat-raw <amount>`
- `--cleanup-max-cycles <count>`
- `--cleanup-budget-ms <ms>`
- `--cleanup-max-transactions <count>`
- `--cleanup-batch-mode <mode>`: `off` or `auto`
- `--cleanup-max-batch-instructions <count>`
- `--cleanup-scan-mode <mode>`: `recent`, `scan`, or `auto`
- `--status-mode <mode>`: `compact`, `ui`, `debug`, or `none`
- `--loop`
- `--interval-seconds <seconds>`
- `--jitter-seconds <seconds>`
- `--max-iterations <count>`
- `--log-file <path>`
- `--lock-file <path>`
- `--stale-lock-seconds <seconds>`
- `--json`

The command also accepts the standard gateway RPC flags such as `--url`,
`--token`, and `--timeout`.

## Practical boundaries

- This is an operator maintenance command, not the normal mining start/stop path.
- It submits through the configured gateway and wallet policy.
- It does not change the SAT cap or create discretionary rewards.
- It should run with a dedicated operator environment, logs, and RPC health
  checks.
- Cleanup is incremental. If old resolved cycle accounts are numerous, a pass can
  submit a small number of cleanup transactions and return `deferred` so the
  next loop pass continues without holding the gateway request open.
- Maintainer responses are compact by default. Use `--status-mode debug` only
  when you need the full dashboard/debug status payload in the CLI response.
- Cleanup discovery uses `recent` mode by default, which starts from cycle
  candidates already observed by this runtime. Use `--cleanup-scan-mode scan`
  only for explicit backfill/debug runs because broad program-account scans get
  slower as public account history grows.
- Cleanup batching is opt-in with `--cleanup-batch-mode auto`. It batches only
  SAT cleanup close instructions and falls back to single cleanup transactions
  when an older local signer does not support the batch operation.

Related:

- [Mining CLI](/cli/mining)
- [SAT mining protocol](/plugins/crypto/mining-protocol)
- [Wallet CLI](/cli/wallet)
