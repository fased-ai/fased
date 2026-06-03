---
title: "Security Test Report"
summary: "Maintained security evidence for gateway access, wallet custody, passkeys, split-key policy, skills, tasks, and SAT maintainer operations."
read_when:
  - Reviewing a Fased host before exposing remote access
  - Checking wallet/passkey/split-key policy before unattended operation
  - Auditing whether Agent skills, tasks, and mining controls stay separated
---

# Security Test Report

This page is the public security evidence report for Fased Agent. It is not a
third-party audit. It records the controls we test, the boundaries that must
hold, and the checks an operator should rerun before treating a host as ready
for unattended wallet, SAT mining, or Fased Network operation.

## Current evidence status

| Area                           | Evidence status          | Notes                                                                                                                                                          |
| ------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway and node access        | Covered                  | Host checks and private-access guidance exist. Operator must verify their own network exposure.                                                                |
| Signer and wallet key safety   | Covered                  | Signer doctor, socket/file permissions, wallet status, and no-key-output checks.                                                                               |
| Wallet role separation         | Covered                  | Agent, Mining, and Vault roles are separate; generic skills must not reach Mining or Vault wallets.                                                            |
| Passkey controls               | Covered                  | Wallet Control Passkey mode, first enrollment, approval, and removal behavior have regression coverage.                                                        |
| Split-key / Vault security     | Covered                  | Vault custody state and manual signing window behavior are tested as Vault policy, not generic passkey state.                                                  |
| Agent skills and wallet grants | Covered                  | Skill install/allowlist is separate from Wallet > Skill Grants. Denied actions fail closed.                                                                    |
| Tasks and automation           | Covered                  | Saved task definitions are separate from run history; mining strategy tasks are strategy-only.                                                                 |
| SAT mining runtime             | Covered on devnet        | Max-capital targets, restart continuity, commit downsizing, and cycle-claim recovery have regression and live evidence.                                        |
| SAT protocol maintainer        | Partial / drill required | Primary maintainer behavior and safe fixed-recipient lanes are documented. Standby, alert delivery, and cleanup backlog evidence must be rerun per deployment. |
| Public hosting posture         | Operator-specific        | Every hosted install must rerun network, auth, firewall, signer, and alert checks.                                                                             |

## What was tested

The security checks focus on the surfaces that can move money, expose a host, or
grant an Agent persistent capability:

- gateway and node access
- local signer and wallet custody
- wallet roles and policy boundaries
- Wallet Control Passkey
- split-key Vault security
- skill installation, Agent allowlists, and wallet grants
- task creation, task execution policy, and run history separation
- SAT mining wallet isolation
- Fased Network Vault/bond authority
- SAT protocol maintainer primary, standby, monitor, and alert paths

The report is meant to answer one question: can a user or operator explain what
is allowed to act, what is only allowed to observe, and what cannot touch wallet
authority at all?

## Gateway and node access

Required evidence:

- gateway auth is enabled for any non-loopback access
- admin UI is private through localhost, Tailscale, or SSH tunnel
- public Fased Network/A2A edge is separate from admin access
- only intended ports are exposed
- Tailscale status is healthy when used
- firewall defaults deny incoming traffic except explicit allows

Useful checks:

```bash
fased doctor --json
ss -ltnp
sudo ufw status verbose
tailscale status
tailscale serve status
```

Expected result:

- gateway admin UI is not exposed publicly without authentication
- node/device access is paired or explicitly allowed
- Tailscale or SSH tunnel access is healthy when used
- public Fased Network exposure, if enabled, is separate from admin access

See also:

- [Security overview](/security)
- [Gateway security](/gateway/security)
- [Tailscale](/gateway/tailscale)
- [Host security baseline](/security/baseline-checklist)

## Signer and wallet key safety

Required evidence:

- `fased-signerd` owns signing operations
- gateway policy and signer custody stay separated
- signer socket permissions are not world-readable
- keystore/passphrase files are not world-readable
- signer audit log is enabled
- raw private keys are not printed in logs, task output, UI, or environment

Useful checks:

```bash
fased wallet signer doctor --json
fased wallet status --json
```

Expected result:

- signer doctor passes
- configured wallets show healthy signer capability
- no raw key material appears in the report

Failure rule:

If a command, UI card, task result, or log line prints a private key, seed
phrase, passphrase, recovery share, or RPC secret, treat it as a security bug.

## Wallet role separation

The wallet role model must fail closed:

| Role   | Intended use                                     | Generic skill access                 |
| ------ | ------------------------------------------------ | ------------------------------------ |
| Agent  | approved sends, skills, services, and automation | allowed only through explicit grants |
| Mining | SAT mining runtime only                          | not available                        |
| Vault  | manual custody and Fased Network bond authority  | not available                        |

Evidence to keep current:

- Agent wallet sends use only allowed Agent-role wallets
- Mining capital and mining submit use the mining wallet path
- Vault bond and staking use the Vault/bond authority path
- deleting or recreating a wallet does not leave stale secured-wallet policy

Expected result:

- generic wallet-capable skills can use only explicitly granted Agent wallets
- Mining wallets are reserved for SAT mining and sweep behavior
- Vault wallets are reserved for manual custody, Fased Network bond, and staking
- wallet aliases such as `@wallet:agent`, `@wallet:mining`, and `@wallet:vault`
  resolve to the intended role and do not silently cross roles

## Passkey controls

Required behavior:

- passkey-off mode allows normal non-passkey wallet/mining flows
- passkey-on mode requires approval for sensitive wallet actions
- first passkey enrollment can happen without an existing passkey
- removing the last passkey is blocked while a secured wallet still depends on it
- passkey removal updates cached wallet-security state

Useful regression areas:

- wallet send approval
- mining capital fund/withdraw approval
- mining sweep policy approval
- passkey remove with deleted wallets
- no stale wallet id aliases after deletion

Expected result:

- passkey-off mode does not dead-end wallet send or mining capital operations
- passkey-on mode requires a real approval for sensitive actions
- no stale "passkey on with no usable passkey" state remains after removal
- first passkey enrollment remains possible

## Split-key / Vault security

Required behavior:

- Vault locked state blocks manual signing
- Vault unlock opens only the intended manual signing window
- locking returns the Vault to the safe state
- split-key security is tied to Vault custody, not generic passkey readiness
- recovery share guidance is visible during setup and not recoverable from chat
  output later

Expected result:

- Vault locked is the default custody state
- Vault unlock is a narrow manual signing state
- Agent auto-sign policy is not confused with Vault split-key custody
- Mining auto-sign behavior is controlled by mining runtime policy, not Vault
  unlock state

## Agent skills and wallet grants

Installing or allowing a skill must not grant wallet access by itself.

Required behavior:

- skill install does not grant wallet access
- Agent skill allowlist does not grant wallet access
- wallet grants define wallet ids, chains, caps, actions, and automation level
- denied wallet actions fail closed
- mining and Vault wallets are not exposed to generic wallet-capable skills

Useful checks:

- install a wallet-capable skill with no wallet grant and verify it cannot send
- grant only one Agent wallet and verify other wallets are unavailable
- verify cap failures are explicit and logged

Expected result:

- a skill can be installed without gaining wallet authority
- a skill can be allowed for an Agent without gaining wallet authority
- wallet authority appears only after a narrow Wallet > Skill Grant
- grant caps, actions, wallet ids, chains, and automation level are visible

## Tasks and automation

Tasks are saved definitions. Run history is audit data, not the task itself.

Required behavior:

- a task can run with no wallet access
- a task can run with selected skills only
- a mining strategy task can inspect mining status/history and propose strategy
  changes without funding, withdrawing, sending, or changing capital risk
- local-only mining tasks do not add web search unless explicitly requested
- task run output records model, skill, delivery, memory, and wallet-policy
  context

Expected result:

- Agent > Tasks shows saved task definitions, not mining or wallet history
- run history stays audit data and does not inflate task counts
- task templates do not silently grant web, wallet, bond, send, or mining-capital
  access
- mining strategy tasks can change strategy intent only when configured;
  they cannot fund, withdraw, send, bond, start, stop, claim, or change capital
  risk

## SAT mining runtime

SAT mining runtime controls are separate from generic Agent task and wallet
skill access. The runtime owns submit/claim scheduling, commit sizing, capital
continuity, and restart recovery for the selected mining wallet.

Regression-tested behavior:

- a max-capital target does not consume the whole funded miner-capital balance
- high configured commit is reduced instead of missing a cycle when free capital
  changes
- the watcher keeps minimum-entry continuity reserve when possible
- one pending cycle can still submit the next cycle without spending all free
  capital
- low free capital submits minimum when possible instead of idling
- service restart preserves active mining mode when locked capital exists

Live-tested behavior:

- after restart, mining stayed `running=true`, `enabledWanted=true`, and
  `drainOnly=false`
- cycles `5933669`, `5933670`, and `5933671` submitted successfully after the
  continuity fix
- settled cycles claimed successfully while the runtime kept free continuity
  capital instead of entering a long skipped-cycle gap

Expected result:

- setting target/max close to total miner capital must not self-lock the wallet
  into repeated skipped cycles
- skipped cycles are still possible when free capital is below minimum entry,
  RPC is unavailable, or cycle claim has not cleared, but max-capital
  target alone should not create a long idle gap

## SAT protocol maintainer

The protocol maintainer path is internal operator tooling. It is not a normal
Mining page control.

Maintainer behavior to verify:

- primary service: `fased-sat-maintainer.service`
- standby timer: `fased-sat-maintainer-standby.timer`
- monitor timer: `fased-sat-maintainer-monitor.timer`
- primary runner lock prevents double-running
- standby skips while primary is active
- standby can run one maintenance pass after primary is stopped
- primary can restart after standby takeover
- monitor checks:
  - no recent successful maintainer pass
  - maintainer failure streak
  - low payer SOL
  - registry reserve below launch buffer
  - pending treasury/staking lanes
- pending mining-cycle backlog
- cleanup/reclaim problem streak

Useful commands:

```bash
systemctl --user status fased-sat-maintainer.service
systemctl --user list-timers fased-sat-maintainer-standby.timer fased-sat-maintainer-monitor.timer --all
tail -n 20 ~/.fased/sat-maintainer.jsonl
cat ~/.fased/sat-maintainer-monitor-state.json
```

Expected result:

- one primary pass runs at a time
- standby does no work while primary is healthy
- standby can take over after primary stops
- repeated maintainer calls do not double-claim, over-refill, or redirect funds
- monitor state reports freshness and failure streaks
- low payer SOL, reserve shortfall, pending lanes, and cleanup backlog produce
  actionable alert state

Release-gate note: before a public or high-value deployment, rerun the
standby/failover drill on that host and keep the maintainer logs, monitor state,
and transaction ids with the release evidence. A local devnet pass does not prove
every hosted install has alert delivery configured correctly.

## What is still operator-specific

This report cannot prove an individual host is safe. Each operator still needs
to verify:

- which interface the gateway binds to
- whether gateway auth is enabled
- which ports are publicly reachable
- whether Tailscale, SSH tunnel, or reverse proxy policy is correct
- whether secrets were pasted into chat, config screenshots, task output, or logs
- whether installed skills and dependencies are trusted
- whether wallet grants match intended operational risk
- whether alert delivery actually reaches the operator

## What this report does not claim

This report does not claim:

- all future versions are safe
- every third-party skill is safe
- every hosted deployment is configured correctly
- public RPC providers are reliable
- wallet loss is impossible
- SAT mining produces predictable economic outcomes
- Fased Network or SAT mainnet launch is complete

For Satcoin protocol evidence, read the Satcoin
[Devnet test report](https://docs.satcoin.app/devnet-test-report).

## What should stay separate

- Mining page: miner-owned mining controls.
- Fased Network page: bond, staking, and Vault authority state.
- Wallets page: wallet roles, grants, passkeys, split-key policy, and balances.
- Agent Tasks: saved automation definitions.
- Logs/history: what already happened.
- Security report: evidence that the boundaries above still hold.

## Release gate

Before a public-hosted or high-value wallet deployment, confirm:

- gateway access is private or authenticated
- signer doctor passes
- wallet role separation passes
- passkey and split-key policy match the intended wallet roles
- skill wallet grants are narrow
- task templates do not include unexpected wallet or web access
- maintainer primary, standby, and monitor are active if SAT protocol
  maintenance is enabled
- alerts have at least one real delivery sink configured for production

## Read next

<Columns>
  <Card title="Security overview" href="/security" icon="shield">
    Review the high-level security model and setup surfaces.
  </Card>
  <Card title="Host baseline" href="/security/baseline-checklist" icon="server">
    Check host, firewall, Tailscale, signer, and systemd posture.
  </Card>
  <Card title="Wallet passkey" href="/plugins/crypto/wallet-control-passkey" icon="key-round">
    Understand passkey approval and split-key wallet security.
  </Card>
  <Card title="Satcoin devnet report" href="https://docs.satcoin.app/devnet-test-report" icon="file-check">
    Read SAT protocol and runtime evidence.
  </Card>
  <Card title="SAT maintainer" href="/plugins/crypto/sat-protocol-maintainer" icon="shield-check">
    Review reserve, treasury, staking, cleanup, standby, and alert checks.
  </Card>
</Columns>
