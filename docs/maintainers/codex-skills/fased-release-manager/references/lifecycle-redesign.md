# Stable Lifecycle Appliance Redesign

Read this reference only for a fundamental installer/updater trust or lifecycle
architecture replacement. For ordinary lifecycle fixes, use `lifecycle.md`.

## Objective

Replace the shell, Node, mutable-path and candidate-root chain with:

```text
short install.sh or fased update
-> static fased-bootstrap
-> signed monotonic release index
-> root-owned immutable inbox
-> separately attested A/B lifecycle host
-> one durable transaction
-> Local or Hosting adapter
-> typed state/signer/plugin participants
-> commit or exact rollback
```

This architecture must cover fresh Local, fresh Hosting, supported public
stable bridge, modern update, rollback, restart/reboot, state preservation and
`Already current` through the same engine and acceptance contract.

The public surface remains one install command per profile and one update
command:

```text
curl .../releases/latest/download/install.sh | bash -s -- --local
curl .../releases/latest/download/install.sh | bash -s -- --hosting
fased update
fased update status
```

Do not expose implementation prerequisites or internal installation paths to
managed users.

## Required controls

1. Bootstrap uses no Node, npm, GitHub CLI, jq or remote setup script before
   Fased trust verification.
2. Root verifies and imports the same opened artifact object. Do not pass an
   unprivileged archive pathname into a privileged importer.
3. Persist a globally monotonic signed release sequence and security epoch.
   Reject lower sequence; rollback requires an exact short-lived authorization.
4. Application generations never contain or select a root lifecycle binary.
   The separately attested lifecycle host is A/B staged by the bootstrap.
5. Fsync every transaction phase and participant receipt. Recover before
   accepting a new command.
6. Quiesce before state capture. Transfer SQLite database families, including
   WAL, SHM and journal, through a database-aware participant.
7. Keep executable plugin code read-only and content-addressed. Store writable
   plugin data separately. Core update cannot update plugin code; drift fails
   closed.
8. Use attested sanitized installed-state capsules in candidate update proof.
   Do not rerun a historical installer to construct the predecessor.
9. Local and Hosting differ only through platform adapters.
10. Candidate P1 repeats already-green branch predicates against final bytes.

## Checkpoints

Execute one checkpoint at a time and stop with exact evidence.

### D0 — Lock policy and red contracts

- Record the literal public commands, one-engine authority map, finite
  compatibility contract, evidence labels, and stable acceptance IDs in the
  canonical architecture document and skill references.
- Reconcile policy and skill wording without copying the incident archive into
  routine skill context.
- Add a red contract for every accepted security finding selected for the
  redesign.
- Add demolition assertions for dynamic Node/gh bootstrap and candidate root
  controller workers.
- Change no product code and run no build, container, CI or release command.

### D1 — Trust and monotonic release index

- Implement Go verification of the existing 2-of-3 lifecycle root, its
  root-authorized GitHub artifact-attestation release authority, and the
  attested release index. Reuse that authority; never generate a second
  ordinary release keypair merely to bridge metadata formats.
- Bind release sequence/security epoch into manifest and transaction.
- Reject downgrade; require explicit rollback authority.

### D2 — Static bootstrap and inbox

- Add the static bootstrap command.
- Stream into root-owned no-follow objects.
- Verify and import the exact objects.
- Add lifecycle-host A/B staging.

### D3 — One privileged lifecycle host

- Move target transaction into the installed host.
- Remove application-supplied root code.
- Migrate to the final supervisor, Gateway and signer service set.

### D4 — Durable recovery

- Persist phases, participant receipts, pointers and undo data.
- Kill/reopen at every phase and prove deterministic recovery.

### D5 — Typed state participants

- Quiesce before capture.
- Add SQLite, signer, wallet, mining, federation, configuration, application
  state and plugin-data participants.
- Verify access under actual target UIDs.

### D6 — Plugin separation

- Add immutable plugin-code store, plugin lock and plugin-data root.
- Remove plugin update from core update.
- Add mandatory plugin readiness receipt.

### D7 — Public route cutover

- Reduce `install.sh` to the bootstrap shim.
- Route managed install/update only through the Go lifecycle path.
- Move development install to a separate script.
- Default to bounded quiet output.

### D8 — Acceptance and capsules

- Add one machine-readable Local/Hosting contract.
- Restore attested predecessor capsules instead of running old installers.
- Remove verifier stubs from enforcing evidence.

### D9 — Demolition

- Delete candidate controller worker, pathname importer, generic shared-state
  owner, managed Node/gh bootstrap and superseded fixtures/routes.
- Reject stale production references.

### D10 — Branch proof

- Build one cached unpublished Linux-x64 artifact.
- Run fresh/update Local and Hosting scenarios concurrently when isolated.
- Reuse exact bytes for rollback, reboot, preservation and `Already current`.

### D11 — Protected delivery

- One clean branch, one focused PR, focused CI and founder squash merge.

### D12 — Release acceptance

- PRE-CANDIDATE on exact merged main.
- One immutable candidate and one build.
- Parallel P1, exact publication, PUBLIC0, owner Local and real Hosting.
- Stable only after both real environments pass.

## Stop rules

- Stop on the first predicate failure and rerun only that predicate after one
  correction.
- Stop after the same predicate fails twice.
- Do not continue if a file outside the checkpoint allowlist changes.
- Do not amend the architecture silently.
- Do not create a PR before D11 or any candidate/release action before D12.
- Report component, branch, candidate and runtime evidence separately.
