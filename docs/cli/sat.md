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

### `fased sat maintain`

Run one SAT protocol maintenance pass through the gateway.

```bash
fased sat maintain --json
fased sat maintain --target-reserve-sol 1 --json
fased sat maintain --min-sol 0.01 --min-sat-raw 100000000000
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

Related:

- [Mining CLI](/cli/mining)
- [SAT mining protocol](/plugins/crypto/mining-protocol)
- [Wallet CLI](/cli/wallet)
