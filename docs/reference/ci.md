---
title: CI Pipeline
description: How the Fased CI pipeline works
summary: "CI job graph, scope gates, and local command equivalents"
read_when:
  - You need to understand why a CI job did or did not run
  - You are debugging failing GitHub Actions checks
---

# CI Pipeline

CI runs on pushes to `main`, pull requests, and manual dispatches. One
authoritative classifier selects the smallest defensible job set from the
cumulative PR diff. The required aggregate check rejects a change when any
selected child job is absent, skipped unexpectedly, or unsuccessful.

## Trusted lifecycle routing

The public classifier is conservative by default. A focused Local-update PR
may use the bounded `local-update` entry point, and an exact root override PR
may use `dependency-remediation`, only when an exact-head,
receipt-bound `fased/private-change-gate` status was published by the configured
trusted actor. PR labels, bodies, manifests, and workflow inputs cannot select
that route. Missing or temporarily unavailable private routing falls back to
the cumulative broad classification; malformed trusted routing fails closed.
The resolver requires both repository variables `FASED_PRIVATE_STATUS_ACTOR`
and `FASED_PRIVATE_STATUS_ACTOR_ID`; the latter is the immutable numeric GitHub
actor ID, not another copy of the login.

The route is a pre-PR input, not a late merge annotation. The required order is
`push branch -> publish and read back the pending private route -> open PR`.
`change-scope` resolves the route once at workflow start; publishing it after
that job has started cannot narrow an already-selected run, so CI intentionally
continues with cumulative lanes. If the route publisher is unavailable, leave
the broad run intact and retry only with a new exact PR head after the route is
published and verified.

## Node lanes

Node validation is split so a focused correction does not trigger the entire
product matrix:

| Lane                   | Purpose                                                |
| ---------------------- | ------------------------------------------------------ |
| `node-focused`         | Allowlisted directly affected tests and root fixture   |
| `dependency-integrity` | Exact override diff, frozen lockfile, production audit |
| `build-artifacts`      | Build `dist/` once for consumers that need it          |
| `release-check`        | Validate package/release contents                      |
| `packed-core-smoke`    | Verify the packed Local package                        |
| `checks`               | Full sharded Node/Bun and protocol matrix              |

Public PR CI runs the changed-surface source tests, applicable workflow
contracts, formatting, and secret scanning selected for the cumulative PR diff.
It does not build a release candidate, run a simulated fresh Local acceptance,
or substitute for literal Local/Hosting/platform evidence. The immutable
multi-platform artifacts are built once by the tag-bound release workflow.

Native Go signer validation, JavaScript signer integration, and Darwin signer
integration are independent lanes. CodeQL is likewise selected independently
for JavaScript/TypeScript, Go, and Python according to the changed languages.
Docker pull-request validation consumes the same classifier as the rest of CI;
the release workflow handles only manual and immutable tag publication.
CI-infrastructure-only changes select contract tests, not product Docker or
production CodeQL. The dependency lane does not build, package, or run product
and lifecycle matrices.

## Fixture prerequisites

Routine lifecycle fixtures use preinstalled prerequisites. Missing-tool and
package-manager bootstrap behavior belongs to the separate
`platform-bootstrap-audit` lane and runs only when installer bootstrap code is
affected (or when selected manually/scheduled).

## Always-retained gates

Every PR retains cumulative classification, applicable workflow
syntax/contracts, secret scanning, selected changed-surface checks, and the
required aggregate context. Lifecycle changes run focused transaction and
rollback/retry regressions as source checks; real-machine acceptance remains a
separate post-publication owner action.

## Time budgets

These are operating budgets, not acceptance shortcuts:

- focused application or Wallet correction: 3–5 minutes before CodeQL, and
  about 5–8 minutes when JavaScript/TypeScript CodeQL is selected;
- focused lifecycle/update PR: 2–3 minutes before CodeQL, and about 5–8 minutes
  including CodeQL; and
- total runner consumption for a focused pull request: at most 15 minutes.

Inspect the active fixture stage when a budget is exceeded. Do not restart the
workflow or add unrelated jobs merely because one selected stage is slow.

## Local Equivalents

```bash
pnpm check          # types + lint + format
pnpm test           # vitest tests
pnpm check:docs     # docs format + lint + broken links
pnpm release:check  # validate npm pack
```

## Strict TypeScript Baseline

`pnpm check:strict` still runs the full native TypeScript check with `pnpm tsgo`.
It is intentionally left as the repo-wide truth source, even while older strict
debt remains in unrelated areas.

Use these helper gates while the repo-wide cleanup is in progress:

```bash
pnpm check:strict:baseline
pnpm check:strict:scoped
```

`check:strict:baseline` writes the current full output and grouped summary under
`.artifacts/strict/`. It is a reporting command and does not hide failures.

`check:strict:scoped` also runs `pnpm tsgo`, but it fails only when strict errors
appear in the wallet, Marketplace, mining, and recently touched UI/tool files.
This gives those lanes a usable no-regression gate while older ACPX, ACP spawn,
config/debug UI, SDK typing, and other repo-wide strict buckets are cleaned in
separate commits.
