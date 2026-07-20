---
title: "Security Test Report"
summary: >-
  Maintained security evidence and pending release gates for gateway access,
  native signer-v2 custody, passkeys, skills, tasks, and SAT operations.
read_when:
  - Reviewing a Fased host before exposing remote access
  - Checking wallet/passkey/signer policy before unattended operation
  - Auditing whether Agent skills, tasks, and mining controls stay separated
---

# Security Test Report

This page is the public security evidence report for Fased Agent. It is not a
third-party audit. It records the controls we test, the boundaries that must
hold, and the checks an operator should rerun before treating a host as ready
for unattended wallet, SAT mining, or Fased Network operation.

## Current evidence status

- Gateway and node access: **covered**. Host checks and private-access guidance
  exist. Operators must verify their own network exposure.
- Signer-v2 and wallet key safety: **pending complete release validation**. The
  controls exist, but this report must not call them covered until fresh Local,
  WSL2, macOS, fresh Hosting, previous-Hosting migration, cold reboot, rollback,
  concurrent-send, ambiguous-broadcast, and Local Docker gates pass together.
- Wallet role separation: **pending complete release validation**. Skill-side
  Agent selection is fail-closed, but the complete signer role matrix and
  Mining confused-deputy tests must pass before this report calls the boundary
  covered.
- Optional Control UI account passkey: **covered at its Gateway boundary**. Mode,
  enrollment, approval, and removal have regression coverage; this is not signer
  custody authorization.
- Signer WebAuthn, fail-closed policy, durable caps/idempotency, and reviewed
  execution: **pending complete release validation**. Go owns these controls;
  the retired split-key/passphrase unlock model is not production custody.
- Agent skills and wallet grants: **covered**. Skill install/allowlist is
  separate from Wallet > Skill Grants. Denied actions fail closed.
- Tasks and automation: **partial / payment-idempotency gate pending**. Saved
  task definitions remain separate from run history and mining strategy tasks
  are strategy-only, but concurrent/restarted settlement and marketplace
  payment workflows must prove one durable execution before release.
- SAT mining runtime: **pending signer-workflow idempotency validation**.
  Max-capital, restart, commit-downsizing, and recovery behavior has regression
  evidence, but every mining mutation still requires the complete stable
  caller-id, ambiguous-broadcast, crash/restart, and concurrency matrix before
  unattended operation is called covered.
- SAT protocol maintainer: **partial / drill required**. Primary maintainer
  behavior and safe fixed-recipient lanes are documented. Standby, alert
  delivery, and cleanup backlog evidence must be rerun per deployment.
- Public hosting posture: **operator-specific**. Every hosted install must rerun
  network, auth, firewall, signer, and alert checks.

## What was tested

The security checks focus on the surfaces that can move money, expose a host, or
grant an Agent persistent capability:

- gateway and node access
- native signer-v2 key lifecycle, sockets, policy, RPC, caps, and custody
- wallet roles and policy boundaries
- optional Control UI account passkey and separate signer-owned approval
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

- Go owns wallet creation/import/re-encryption, policy, execution RPC, signer
  WebAuthn, caps, signing, and reconciliation
- Hosting runs the Gateway as `app` and the signer as `fased-signer`
- `/run/fased-signerd/app.sock` is group-authorized `0660`; the Gateway has no
  access to `/run/fased-signerd/control.sock` (`0600`)
- `/var/lib/fased-signerd/state.db`, `master.key`, and `audit.jsonl` are
  signer-owned inside a `0700` directory
- the Gateway has no signer sudo rule and cannot execute app-controlled code as
  `fased-signer`
- the fixed root updater verifies exact tagged artifact digest and attestation,
  gates mutations, snapshots state, and rolls back/quarantines failure
- raw private keys, RPC execution secrets, and signer credentials are not
  printed in logs, task output, UI, argv, or environment

Useful checks:

```bash
fased wallet signer doctor --json
fased wallet status --json
sudo systemctl status fased-signerd.service fased-host-updater.service --no-pager
sudo stat -c '%U:%G %a %n' \
  /var/lib/fased-signerd \
  /var/lib/fased-signerd/state.db \
  /var/lib/fased-signerd/master.key \
  /var/lib/fased-signerd/audit.jsonl \
  /run/fased-signerd/app.sock \
  /run/fased-signerd/control.sock
```

Expected result:

- signer doctor passes
- configured wallets show protocol-v2 capability, exact policy/network hashes,
  and no legacy Node keystore path
- `app` can connect only to the application socket and has no signer sudo
- no raw key material appears in the report

Failure rule:

If a command, UI card, task result, or log line prints a private key, seed
phrase, passphrase, signer credential, or execution RPC secret, treat it as a
security bug.

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
- archive first durably tightens the native policy to deny-all, then unregisters;
  failure to lock must leave the wallet registered

Expected result:

- generic wallet-capable skills can use only explicitly granted Agent wallets
- Mining wallets are reserved for SAT mining and sweep behavior
- Vault wallets are reserved for manual custody, Fased Network bond, and staking
- wallet aliases such as `@wallet:agent`, `@wallet:mining`, and `@wallet:vault`
  resolve to the intended role and do not silently cross roles

## Control UI account passkey

Required behavior:

- passkey-off mode does not claim signer custody authorization
- passkey-on mode authenticates sensitive Gateway approval/settings actions
- first passkey enrollment can happen without an existing passkey
- Gateway passkey removal updates Gateway approval state only

Useful regression areas:

- wallet send approval
- Gateway wallet/settings approval
- passkey remove with deleted wallets
- no stale wallet id aliases after deletion

Expected result:

- Gateway passkey state never substitutes for signer WebAuthn
- no stale "passkey on with no usable passkey" state remains after removal
- first passkey enrollment remains possible

## Native signer WebAuthn, policy, and durable execution

Required behavior:

- missing policy and empty operations/programs/assets/destinations deny all
- every executable asset has positive per-transaction and daily caps
- every manual native Agent, Mining, or Vault review requires signer WebAuthn
  bound to the exact digest, decoded intent, policy hash, nonce, and expiry
- native signer credential registration, listing, and fenced atomic revocation
  work through the signer-only launcher/control socket; revocation invalidates
  pending proof authority and refuses removal of the last credential unless the
  host administrator gives the explicit last-credential confirmation
- request ids, cap reservations, daily totals, signed bytes, and
  reserved/broadcast/confirmed/failed/unknown states survive restart
- an ambiguous result reconciles the exact existing signature and is never
  automatically rebroadcast

Expected result:

- new wallets activate the exact signer-owned role baseline and remain denied
  outside its typed operations, reviewed destinations, and positive caps;
  legacy explicit deny-all wallets remain deny-all until one owner-reviewed
  baseline activation
- concurrent requests cannot both consume the same remaining cap
- restarting does not reset daily accounting or create a replacement request
- the legacy split-key/passphrase unlock and Node custody routes remain absent

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
  - pending treasury and distributor lanes
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
- Wallets page: wallet roles, grants, Gateway passkeys, review intent, and balances.
- Native signer: keys, policy, signer WebAuthn, execution RPC, durable caps, and
  reviewed execution.
- Agent Tasks: saved automation definitions.
- Logs/history: what already happened.
- Security report: evidence that the boundaries above still hold.

## Release gate

Before a public-hosted or high-value wallet deployment, confirm:

- gateway access is private or authenticated
- signer doctor passes
- wallet role separation passes
- Control UI account passkey and separate signer-owned approval are not conflated
- signer policy/RPC hashes, positive caps, and role-specific typed operations
  match the intended wallets
- fresh Local, WSL2, macOS, Hosting, prior-Hosting migration, cold reboot,
  rollback, concurrent-send, ambiguous-broadcast, and Local Docker checks pass
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
    Distinguish Gateway passkey authentication from exact signer WebAuthn.
  </Card>
  <Card title="Satcoin devnet report" href="https://docs.satcoin.app/devnet-test-report" icon="file-check">
    Read SAT protocol and runtime evidence.
  </Card>
  <Card title="SAT maintainer" href="/plugins/crypto/sat-protocol-maintainer" icon="shield-check">
    Review reserve, treasury, staking, cleanup, standby, and alert checks.
  </Card>
</Columns>
