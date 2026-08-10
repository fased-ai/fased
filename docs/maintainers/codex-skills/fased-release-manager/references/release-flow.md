# Fased PR and Release Flow

Use this document only after selecting `BUG/PR` or `RELEASE` mode in
[policy.md](policy.md). It contains no candidate-specific version or test
count.

## BUG/PR

1. Work from one clean issue branch based on current `origin/main`. Preserve
   unrelated user work in other worktrees.
2. Reproduce the exact symptom and capture the first failed predicate.
3. Add or identify the nearest deterministic red-capable regression.
4. Make one coherent correction. Run only that regression and directly coupled
   source/security checks.
5. If generated units, privilege, custody, trust, or rollback changed, run one
   selected root-capable T2. Check `sudo -n true` first.
6. For installer/updater/lifecycle changes, build unpublished artifacts from
   the exact local branch and run the affected public-style packaged
   transaction through restart, preservation, and identical-command `Already
current`. Keep every correction on this same branch; do not use a PR or
   candidate to discover the next predicate.
7. Format and lint changed files, run `git diff --check`, create the final local
   commit, and push once.
8. Open one focused PR. Public CI derives its plan from the protected base and
   changed paths. Do not publish private route or merge statuses.
9. Arm auto-merge after exact-head and required-check discovery. If the PR is
   `BEHIND`, update its branch once and let strict checks rerun. Observe the
   existing run without continuous polling.
10. If CI fails, inspect the first predicate, correct it locally, and make at
    most one corrective push before reassessing.
11. When the required `checks` aggregate passes and the exact head is mergeable,
    squash-merge without bypass and delete the issue branch.
12. Fetch and point local `main` exactly at `origin/main`; verify commit and tree
    equality.

Target p95: 90 seconds for docs/version/fixture changes and three minutes for a
focused product PR. Cross-boundary installer/updater/signer PRs have a seven
minute p95 target. An exceeded target triggers route inspection, not evidence
invalidation or a new workflow attempt.

For a dependency-only change, run frozen install, production audit, lockfile
integrity, the exact resolved dependency-path check, affected package tests,
and a build only when runtime output can change. A root manifest or lockfile
change alone does not justify the full Node suite. Use the full matrix only
when the resolution can affect the entire product and record that reason;
otherwise run it at the scheduled or candidate boundary.

## RELEASE: prepare candidate

Candidate versions are never diagnostic. For lifecycle changes, this checkpoint
confirms the branch-local packaged closure on merged identity; it must not be
the first packaged execution. Before changing the version, run the following
against one unchanged, exact merged `origin/main` commit:

```text
frozen install
-> production audit
-> release validation
-> public compatibility/inventory verification
-> exact public-style installer acquisition preproof
-> candidate-input preflight
-> PRE-CANDIDATE PASS
```

The acquisition preproof must use the stamped installer and the same asset
names, manifests, attestations, source-reference policy, commit/tag binding,
and lifecycle entry point used by the public command. It must cover fresh
Local and the supported stable-to-candidate update, then restart,
state-preservation, and `Already current`. Serving the unpublished candidate
assets from an isolated fixture is acceptable; bypassing acquisition by
injecting the Actions artifact directly is supporting evidence only.

Before correcting an installer trust predicate, enumerate every equivalent
verifier across bootstrap, runtime acquisition, Local, and Hosting. Replace
duplicated policy with one shared contract and test every consumer. Do not
publish a candidate when any public entry-point predicate exists outside P1.

If any predicate fails or is unrun, stay in `BUG/PR`. Do not edit a version,
open a version PR, tag, dispatch, reserve, or describe an RC as ready. After a
product correction merges, repeat this checkpoint once on the new unchanged
commit. Only the literal `PRE-CANDIDATE PASS` authorizes the version-only PR.

Prerequisites:

- exact merged `origin/main` is clean;
- the same exact commit has a recorded `PRE-CANDIDATE PASS`;
- package/version inventory agrees;
- requested version, tag, and GitHub Release are unused before the owner tag
  ceremony;
- owner has authorized candidate preparation;
- the `candidate-release` environment retains its required owner reviewer; and
- release-tag rules permit creation only by the owner while forbidding update
  and deletion.

After the version-only PR merges and PRE-CANDIDATE remains bound, the owner
creates one lightweight `v<release_version>` tag at `source_commit` and verifies
it remotely. Creating the tag does not trigger a workflow. Dispatch
`.github/workflows/hosted-runtime-release.yml` from that exact tag with:

- `release_version`: the package version without `v`;
- `source_commit`: the exact current `origin/main` commit; and
- `predecessor_version`: the latest supported public stable version. The
  workflow derives required P1 topology scenarios from the compatibility
  inventory; operators never select a scenario manually.

The workflow must:

1. read back the immutable tag, protected `main`, source commit, and version
   identity and require exact equality;
2. install from the frozen lockfile and enforce production audit policy;
3. build shared `dist` once;
4. package each supported architecture once from that exact dist;
5. build/test the native signer and assemble provenance, SBOM, VEX, manifests,
   and attestations;
6. write one immutable candidate descriptor with exact artifact inventory;
7. derive the supported predecessor topology from the complete public-release
   compatibility inventory and run independent fresh Local,
   supported-stable update/rollback, and Hosting adapter jobs concurrently
   against the same downloaded candidate artifact through the exact
   public-style acquisition entry point; and
8. wait at `candidate-release` before publication.

Every build attestation must therefore carry
`refs/tags/v<release_version>`, matching the signed lifecycle-root authority.
When P1 is green, the owner approves the waiting environment job. The
publication job must reverify the tag, download the existing run artifact,
verify every identity/attestation, create one draft, upload all bytes, compare
remote name/size/SHA-256 inventory, and expose the release only after equality
passes. It never builds or attests new bytes.

If P1 has an infrastructure-only failure, rerun failed jobs once. Candidate
verification binds the original workflow run and candidate manifest but permits
the later attempt to consume those exact bytes. A product failure requires a
new source commit and candidate; never rebuild the failed identity.

P1 is confirmation, never discovery. Every source-dependent predicate must
already have an equivalent passing Linux x64 branch-local result, and any
product change after that result invalidates it before candidate allocation.

## npm and PUBLIC0

After GitHub prerelease readback succeeds:

1. Generate the authoritative publishable-package inventory from the exact
   candidate source.
2. The owner publishes every listed package with the intended prerelease tag.
3. Verify exact versions and dist-tags from npm.
4. Run PUBLIC0 once to read back GitHub and npm identities. Do not rebuild,
   retest P1, or change product evidence.

npm is owner-operated unless the current request explicitly authorizes Codex
publication. Never expose tokens in command output or receipts.

## Installed acceptance

### Local

Run the literal public installation/update command on the authorized owner
machine. Bind before/after state inventories. Require:

- exact candidate version and public acquisition path;
- healthy lifecycle supervisor, controller, signer, and Gateway services;
- Wallet, signer database/master key, Mining ledger, Network identity, policy,
  and plugin state preserved except declared migrations;
- successful restart and health readback; and
- the identical command returning `Already current` without mutation.

Mixed private-development residue is not an updater compatibility class. Back
it up and invoke the explicit repair operation to recreate replaceable control
state around preserved custody/user state.

### Hosting

Run real Hosting fresh/update acceptance only at the candidate/stable boundary
on an owner-authorized VPS with the intended Tailscale/network policy. Verify
filesystem ownership, units, signer/Gateway health, restart, preservation,
rollback/retry, and idempotence. A container or Docker fixture is supporting,
not H1/H2.

## Stable promotion

Promote stable only when the exact candidate has:

- candidate build and artifact inventory `PASS`;
- packaged P1 `PASS`;
- GitHub and npm PUBLIC0 `PASS`;
- affected Local acceptance `PASS`;
- real Hosting acceptance `PASS`; and
- no unresolved product failure or changed artifact.

Stable promotion reuses exact candidate bytes and changes only authorized
release/dist-tag metadata. Read back the result. Never rebuild during
promotion.
