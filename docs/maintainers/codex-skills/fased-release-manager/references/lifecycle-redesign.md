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
8. Prove supported public predecessors by running their authentic documented
   installer and the canonical takeover path. Sanitized installed-state
   capsules are supporting failure-injection fixtures only, never a substitute
   for public acquisition or owner-machine evidence.
9. Local and Hosting differ only through platform adapters.
10. Candidate P1 verifies final artifact inventory, provenance, and bound receipts
    without repeating already-green product execution.
11. Managed repair is bound to the exact installed manifest and generation; it
    cannot select a release or change state schemas. Managed uninstall is a
    monotonic Go transaction that preserves owner data and signer custody by
    default and rejects legacy application deletion scopes.
12. Hosting uninstall restores only controls claimed by a write-once
    first-install ownership baseline. Later updates cannot replace that
    baseline or claim pre-existing Tailscale, Serve, SSH/firewall, update, or
    signer configuration.

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
- Require a short-lived GitHub/Sigstore-attested root-head witness from the
  protected release workflow. It binds the newest root and index digests;
  missing future root assets fail closed instead of treating HTTP `404` as a
  signed statement of absence. Refresh the witness independently from product
  bytes and serialize it with channel publication.
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
- Publish channel selection only as a signed monotonic record that points to an
  already-public exact release; stage and verify channel assets before the
  canonical names change, and make retries complete the same transaction.

### D8 — Acceptance and capsules

- Add one machine-readable Local/Hosting contract.
- Run the authentic supported predecessor installer and canonical takeover for
  enforcing compatibility evidence; use attested capsules only for supporting
  deterministic failure and recovery coverage.
- Remove verifier stubs from enforcing evidence.

### D9 — Demolition

- Delete candidate controller worker, pathname importer, generic shared-state
  owner, managed Node/gh bootstrap and superseded fixtures/routes.
- Reject stale production references.
- Fence application-owned repair and uninstall before any managed mutation.
- Prove exact-current repair rollback and crash-resumable uninstall while
  preserving configuration, workspaces, plugin data, signer custody, and the
  durable instance/account identity needed for reinstall.
- Keep every retained platform row blocked until its real service-manager and
  peer-auth adapter has command-backed evidence; an empty Darwin or WSL2
  adapter is not parity.

### D10 — Historical branch proof (superseded)

- The former LOCAL0/container branch proof is retired. It never constituted
  Local or Hosting acceptance.
- Build one cached unpublished Linux-x64 artifact after source is final and bind
  its commit, tree, lockfile, inventory, provenance and contract digest.
- Execute only the affected real environment; keep focused transaction tests as
  source evidence and optional containers as `SUPPORTING` diagnostics.

### D11 — Protected delivery

- One clean branch, one focused PR, focused changed-surface CI and founder
  squash merge. Broad matrices run weekly or manually.

### D12 — Release acceptance

- Require exact real affected-environment evidence, then PRE-CANDIDATE on exact
  merged main. Only after both pass may the next unused RC be allocated.
- One immutable candidate and one build.
- Receipt-and-inventory P1, exact publication, signed channel advancement from
  those same bytes, PUBLIC0, owner Local and real Hosting.
- PUBLIC0 supplies immutable-GitHub-Release readback after publication; P1
  verifies the exact artifact inventory and receipts without replaying product
  execution.
- Stable only after both real environments pass.

## Stop rules

- Stop on the first predicate failure and rerun only that predicate after one
  correction.
- Stop after the same predicate fails twice.
- Do not continue if a file outside the checkpoint allowlist changes.
- Do not amend the architecture silently.
- Do not create a PR before D11 or any candidate/release action before D12.
- Report component, branch, candidate and runtime evidence separately.
