# Fased Signer And Lifecycle Contract

Read this document only when installer, updater, signer, wallet custody,
migration, system service, Local, or Hosting behavior is affected.

Historical implementation and RC incident records are archived under
[`../archive/incidents/`](../archive/incidents/).

The authoritative install, update, repair, shared-state, and onboarding
architecture is
[lifecycle-architecture.md](lifecycle-architecture.md). This document selects
signer and lifecycle acceptance evidence; it does not define a second
transaction.

## Signer Boundary

The supported target uses one protected signer with platform-aware OS
isolation:

- `fased-signerd` owns keys, policy, network identity, audit, and signing.
- The native Go operator client owns typed wallet lifecycle operations.
- Gateway JavaScript uses the signer application socket only.
- A bounded root controller owns installation, privileged service mutation,
  transactional activation, rollback, and recovery.
- Human wallet operations use a restricted operator socket.
- Owner-only recovery, export, re-encryption, credential enrollment, and
  privileged rotation remain outside Gateway.

Linux Local and Hosting must enforce separate service identities, bounded
sockets, ownership, and modes. macOS cannot reproduce Linux user/service
isolation; it must preserve protocol, custody, least-privilege process, and
keychain/file-permission guarantees without claiming identical OS isolation.

## Canonical Client Rule

Every normal wallet lifecycle operation must use the native typed operator
client:

- create/import;
- role readiness;
- policy baseline;
- RPC verification/replacement;
- routing and wallet selection;
- Mining lifecycle;
- approved signing and execution.

Do not duplicate signer protocol framing, response parsing, policy decisions,
or wallet identity rules in shell or JavaScript.

## Transaction Rule

Use the target-first state machines and exclusive phase ownership in
[lifecycle-architecture.md](lifecycle-architecture.md). In particular, the
installed old updater becomes read-only after target-controller handoff, and
onboarding begins only after a committed healthy transaction.

Workflow order, phase selection, failure handling, and authorization are owned
only by [policy.md](policy.md) and [test-selection.md](test-selection.md). This
document owns only signer/Wallet and `G0`-`H2` evidence semantics.

## G0 — Native Protocol And Security

Require:

- framing and message size bounds;
- request/response identity binding;
- authorization by socket and operation;
- canonical wallet ID, role, policy, RPC, and network validation;
- concurrency/race tests for affected Go code;
- failure responses that do not leak protected material; and
- exact release/protocol identity.

## G1 — Cross-Language Operator Path

Use the real application caller and real signer process/socket. Prove each
affected operation travels through the typed native client and produces the
expected signer-owned state. A pure Go or JavaScript mock is only
`SUPPORTING`.

## G2 — Shared Wallet Lifecycle

Prove affected create/import/readiness/policy/RPC/routing/approval/signing
behavior with real signer state. Preserve:

- stable internal wallet ID;
- user-facing wallet handle;
- public address;
- immutable role;
- role baseline and optional policy/grant distinction;
- verified RPC/network identity; and
- audit/approval result reconciliation.

## L0 — Anonymous Fresh Local

Use a truly empty, anonymous, systemd-capable disposable boundary with an
isolated OS user, home, state, runtime, cache, config, and free port.

Require:

- literal documented install command;
- exact packaged candidate and verified signer;
- protected users/services/sockets on Linux;
- onboarding, wallet/RPC, Gateway, and plugin health;
- restart and reboot persistence;
- no contamination from the owner installation; and
- final fast idempotent update.

An active developer installation is not L0.

Deterministic installer regressions run before push. Full exact-candidate `L0`
may run in applicable PR CI, but the literal published installer is confirmed
again after the immutable RC and complete npm beta exist.

## L1 — Existing Local Update And Migration

`L0` and `L1` are independent. For a known existing-update failure, run `L1`
first; do not run `L0` as a diagnostic. Before stable promotion, both must pass
when the cumulative changed surfaces select both. Use:

```bash
fased update
```

For an explicitly selected prerelease:

```bash
fased update --channel beta
```

Select latest stable and one fixture per distinct supported updater, state, or
service boundary—not every historical patch.

Require:

- wallet identity/policy/RPC preservation;
- target-first controller activation;
- exact identity convergence;
- deterministic injected failure and automatic rollback;
- same-command retry;
- restart/reboot persistence; and
- final `Already current` without migration or restart.

Reinstalling before the update invalidates L1.

A supported pre-supervisor Local topology is the sole Local exception. This
includes a recognized Protected Local installation whose legacy flat updater
bundle is incomplete and therefore cannot execute target code. Run the
documented verified Local installer once to establish the supervisor and one
complete atomic updater generation without onboarding, then prove the
resulting installation with ordinary `fased update`, rollback/retry, restart,
and final idempotence. An explicit repair command or a named intermediate
release invalidates this compatibility evidence.

Before push, deterministic update regressions and the selected root-capable
fixture prove the changed transaction. PR CI then proves representative clean
fixtures, and the immutable published candidate is confirmed once with the
ordinary command.

## H0 — Supporting Hosting Fixtures

Run only the selected Hosting adapter/systemd fixtures with one exact reused
candidate. Add a second distribution only when its adapter, package bootstrap,
or service behavior changed. Prove:

- root to app handoff;
- controller, operator, and application sockets;
- users, groups, ownership, and modes;
- Gateway/signer/updater service order and readiness;
- Tailscale output parsing, delayed readiness, trailing output, and failures;
- loopback binding and public-port rejection;
- fresh, partial retry, update, rollback, restart, and reboot transitions.

H0 is `SUPPORTING`; it cannot prove a real tailnet or provider kernel.

Keep package-manager/missing-dependency bootstrap in a separate scheduled or
affected compatibility job. Normal cached fixtures target five minutes.

## H1 — Fresh Real Hosting

On clean supported Ubuntu and RHEL-family VPSs:

- run one literal RC one-curl command;
- approve Tailscale interactively;
- require automatic DNS discovery;
- operate as the normal `app` user afterward;
- verify private dashboard and rejection through the public address;
- verify Gateway, signer, updater, sockets, wallets, and state across reboot.

No GitHub login, npm fallback, manual DNS retyping, privileged artifact copy,
or hidden repair is allowed.

## H2 — Existing Hosting Update

H2 is independent from H1. For an existing-Hosting update defect, select H2
first; run H1 only when fresh Hosting is also affected. Update the selected
supported Hosting boundary with the normal command and prove rollback,
same-command retry, restart/reboot, wallet/signer/state preservation, and final
idempotence.

## Candidate Identity

Bind every fixture to:

- version;
- source commit/tree;
- application digest;
- dependency digest;
- controller identity;
- signer identity; and
- release manifest.

If any half uses another RC, `latest`, a source checkout, or a stale
controller, report `INVALID` and correct the harness before diagnosing the
product.

## Production Decision

Source tests and H0 do not make Hosting production-ready. Stable promotion
requires every triggered literal release gate to record exact `PASS` evidence.
An owner waiver may document risk or narrow the supported surface, but it can
never close or authorize a release-required gate.
