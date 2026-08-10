# Fased Change and Release Policy

This is the durable authorization and evidence policy for Fased. It is
version-neutral. Concrete versions, commits, machines, and outcomes belong in
GitHub runs, release manifests, and acceptance records—not in this policy.

Repository: `/home/fc/fasedbot/fased`
Remote: `git@github-fased:fased-ai/fased.git`

## Select one mode

- `REPORT`: inspect and report. Make no source, GitHub, release, or installation
  changes.
- `BUG/PR`: reproduce one predicate, make one coherent correction, run focused
  evidence, and use one protected PR.
- `RELEASE`: start from one exact merged `origin/main` commit after explicit
  candidate or stable authorization.

Do not combine modes. Ordinary bug and PR work must never read or mutate
`state/current.json`, release receipts, candidate gates, or private GitHub
statuses. The former global ledger and its binders/publishers are historical
evidence only.

Installer/updater/lifecycle bugs remain in `BUG/PR` while running an
unpublished branch-local packaged transaction. That local closure is not a
candidate, release gate, or permission to mutate release state.

## Ordinary PR contract

```text
symptom -> narrow red test -> fix -> narrow green test
-> lifecycle changes: branch-local packaged public-style closure
-> changed-file formatting/diff check -> one final push -> one PR
-> one aggregate CI result -> protected exact-head squash merge
```

- Classification is a pure function of protected-base policy plus changed
  paths. PR-head code is not executed by `pull_request_target`.
- Unknown production paths fail with their exact names. Missing diff evidence
  selects conservative checks.
- Run only affected source, security, language, and privilege contracts.
- A privileged boundary change adds one root-capable T2 before push. T2 is not
  a fresh install, packaged P1, or owner acceptance.
- Installer/updater/lifecycle changes must additionally pass one unpublished
  branch-local packaged execution of the affected end-user transaction before
  the first push. Require restart, preservation, and an identical-command
  `Already current`. Unit tests and T2 cannot replace this closure.
- Keep all corrections exposed by that transaction on the same local incident
  branch. A PR is a delivery boundary, never a diagnostic boundary.
- PR CI never builds release artifacts, publishes, or runs packaged lifecycle
  acceptance.
- Required `checks`, strict up-to-date policy, squash-only PR merge, linear
  history, deletion protection, and no bypass remain enforced by GitHub.
- A merged-main run reuses successful protected PR evidence only when the PR is
  merged, its merge commit equals current main, its tested head tree equals the
  merged-main tree, and `PR / checks` succeeded. That run does not repeat Node,
  CodeQL, build, package, Docker, or lifecycle jobs.
- After squash merge, fetch and set local `main` exactly to `origin/main`; do
  not use a normal pull to reconcile squash history.

Read [test-selection.md](test-selection.md) only when selecting affected tests.

## Candidate contract

Never use a candidate version to discover source failures. Lifecycle source
must already have passed branch-local packaged closure before its PR. Before
any version edit, require `PRE-CANDIDATE PASS` on unchanged merged main: frozen install,
production audit, release validation, public compatibility/inventory
verification, and candidate-input preflight. Any failure returns to `BUG/PR`
without allocating an RC.

One protected manual workflow is dispatched from an owner-created immutable
tag that points at the exact current `origin/main` commit:

```text
verify version + commit + tree + frozen lockfile
-> verify immutable tag and protected-main equality
-> production audit
-> build shared dist once
-> package each architecture once
-> immutable candidate manifest and attestations
-> packaged P1 against those exact bytes
-> publication job waits at protected candidate-release environment
-> owner approves the waiting publication job
-> verify the tag, publish, and read back the same bytes
```

Creating the tag does not trigger a build; the manual workflow must be
dispatched with that exact tag as its GitHub source ref. Publication never
rebuilds. The candidate
manifest binds version, commit, tree, lockfile digest, workflow run/attempt,
artifact names, sizes, SHA-256 values, provenance, SBOM, VEX, and attestation
identities. Later outcomes reference its digest; they do not edit it.

P1 must cover fresh protected Local installation and the latest supported
public stable to candidate, including injected failure, exact rollback,
same-command retry, restart health, declared state preservation, and `Already
current`. Add another predecessor fixture only for a materially distinct public
schema/topology/capability still supported. Never multiply by private RCs.

Classify candidate failures as:

- `PRODUCT_FAIL`: a product predicate failed; change source and use a new
  candidate identity.
- `INFRA_FAIL`: infrastructure failed before a product verdict; retry failed
  jobs once against the same artifact identity.
- `PASS`: the exact artifact may proceed.

## Publication and acceptance

```text
GitHub prerelease exact bytes
-> owner npm beta publication
-> PUBLIC0 readback
-> literal owner Local acceptance
-> real Hosting acceptance
-> stable promotion
```

- npm publication remains a manual owner command boundary. Codex may prepare,
  dry-pack, print plain publish commands without authentication arguments, and
  verify readback; it never invokes `npm publish` or handles OTP/token material.
- PUBLIC0 is readback-only: GitHub names/sizes/digests, npm inventory and beta
  tags, with unchanged latest tags. It never rebuilds or reruns P1.
- Local acceptance verifies acquisition, services, signer/Gateway/Wallet/
  Mining/Network/plugins, restart, preserved state, and repeated `Already
current`.
- Hosting acceptance uses a real authorized VPS/Tailscale boundary before
  stable; containers are supporting fixtures, not Hosting acceptance.
- Stable promotion is version/publication metadata only after required Local
  and Hosting acceptance pass for the exact candidate.

Read [release-flow.md](release-flow.md) only in `RELEASE` mode. Read
[lifecycle-architecture.md](lifecycle-architecture.md) for install, update,
migration, repair, service, or onboarding changes. Read
[signer-lifecycle.md](signer-lifecycle.md) for signer/Wallet custody evidence.

## Security and simplicity invariants

- Preserve unrelated work and never commit secrets, Wallet data, credentials,
  private endpoints, state roots, caches, backups, or logs.
- One component owns each mutation. One candidate run owns one artifact set.
  One lifecycle coordinator owns one update journal.
- Do not add production branches for private prerelease residue. Use one
  owner-authorized repair into the canonical topology.
- Every external/network/service/lock/health wait has a timeout and prints the
  first failed predicate.
- If sudo is selected, check `sudo -n true` immediately. If unavailable, report
  `NOT RUN: sudo credential expired`; never poll or loop.
- Observe existing CI by run ID. Never restart a running job, create another
  plan generation, or rebuild unchanged candidate bytes.
- After the same predicate fails twice, stop editing and reassess the ownership
  boundary.
- Merge, tag, GitHub Release, Docker publication, npm publication, owner
  infrastructure, and stable promotion remain explicit authorization
  boundaries unless the current request names the longer sequence.
