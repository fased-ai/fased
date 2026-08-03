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

The focused Local-update route retains exact L1 update, rollback, retry,
restart, reboot, state-preservation, and final-idempotence evidence. It does
not run fresh Local L0. Fresh Ubuntu, Rocky compatibility, Hosting, Docker,
macOS/iOS, Mining UI, and broad product jobs run only when their changed
surface selects them.

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

Every PR retains cumulative classification, workflow syntax/contracts, secret
scanning, the selected L1/T2 and rollback/retry gates, and the aggregate
`checks` context. Version-only changes use only identity and release metadata
checks. A trusted exact dependency remediation runs dependency integrity and
secrets only; broader work activates the corresponding surface lanes.

## Time budgets

These are operating budgets, not acceptance shortcuts:

- focused application or Wallet correction: 3–5 minutes before CodeQL, and
  about 5–8 minutes when JavaScript/TypeScript CodeQL is selected;
- privileged Local-update correction: 6–10 minutes;
- version-only pull request: 2–3 minutes; and
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
