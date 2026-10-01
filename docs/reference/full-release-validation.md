---
title: "Full Release Validation"
summary: "Public-launch checklist using the checked-in Fased scripts and smoke lanes"
read_when:
  - Preparing a public Fased release
  - Validating docs, install flows, Control UI, Agent flow, Docker, or live-provider lanes
  - Deciding which checks are required vs optional before pushing a release branch
---

# Full Release Validation

This page is a release checklist around scripts that exist in this repository.
It does not define new product behavior.

Run the required checks before a public release branch is pushed. Run optional
lanes when the release touches that subsystem or when release hardware/secrets
are available.

## Required Local Gate

Start from the Fased repository root:

```bash
pnpm exec tsc --noEmit
pnpm check
pnpm build
pnpm ui:build
pnpm test:fast
pnpm test:ui
pnpm test:smoke:agent-flow
pnpm check:docs
```

What this covers:

- `pnpm check`: formatting, lint, docs temp guards, auth/channel boundary
  guards, and Swift env-policy generation check.
- `pnpm build`: TypeScript bundle, plugin SDK d.ts, protocol/build metadata,
  and canvas/export template copies.
- `pnpm ui:build`: Control UI production build.
- `pnpm test:fast`: unit suite through `vitest.unit.config.ts`.
- `pnpm test:ui`: Control UI test suite plus raw-window-open guard.
- `pnpm test:smoke:agent-flow`: composite Provider -> Agent -> Skill -> Chat
  -> Task -> Memory -> Channel delivery smoke lane.
- `pnpm check:docs`: docs formatting, markdown lint, and internal link audit.
- `pnpm exec tsc --noEmit`: repository TypeScript gate without emitting files.

If the default Gateway port is occupied from local work, use:

```bash
pnpm test:force
```

## Gateway and Runtime Smoke

Run this when Gateway routing, websocket/http behavior, node pairing, sessions,
or operator pages changed:

```bash
pnpm test:e2e
```

Useful focused lanes:

```bash
pnpm test:loopback
pnpm test:browser-cdp
```

`test:browser-cdp` requires a loopback/CDP-capable environment.

## Task Run History Smoke

Run this focused browser smoke when Agent > Tasks, webhook triggers, workflow
templates, workflow graph review, or approval resume behavior changes:

```bash
pnpm exec vitest run --config vitest.e2e.config.ts test/control-ui-task-workflow.browser-smoke.e2e.test.ts
```

It starts a real Gateway/Control UI test instance and verifies:

- a webhook trigger can receive a test payload
- the payload creates a task run-history record
- Agent > Tasks opens the source task
- a run-history-backed workflow can be reviewed from that source
- approval/resume continues the same workflow record
- domain authority stays outside the workflow layer

## Docker Smoke

Docker checks are slower and require Docker/Podman-compatible host support. Use
them for onboarding, plugin, gateway-network, and cleanup changes.

Focused lanes:

```bash
pnpm test:docker:onboard
pnpm test:docker:qr
pnpm test:docker:plugins
pnpm test:docker:gateway-network
```

Full container lane:

```bash
pnpm test:docker:all
```

Managed Local and Hosting installation are proved by the lifecycle acceptance
fixtures and candidate P1. The retired npm installer smoke is not a release
gate.

## Live Provider Checks

Live checks require credentials and should not run in normal local development:

```bash
FASED_LIVE_TEST=1 pnpm test:live
```

Provider-specific live checks may require provider env vars such as
`MINIMAX_API_KEY`, `ZAI_API_KEY`, or other keys documented by the test itself.

Before treating a live failure as a code regression, separate:

- provider outage or quota/rate limits
- bad release secrets
- model catalog changes
- network/DNS failure on the runner
- actual runtime regression

## Mobile and Desktop App Checks

Run only on hosts with the required SDK/toolchain:

```bash
pnpm android:test
pnpm android:assemble
pnpm ios:gen
pnpm ios:build
pnpm mac:package
```

Use platform docs for device-specific setup. Do not block a server-only patch on
mobile packaging unless the release includes mobile changes.

## Docs Release Gate

For docs-only release work:

```bash
pnpm format:docs:check
pnpm lint:docs
pnpm docs:check-links
```

Before public launch docs are final, manually review:

## Manual Product Smoke

Use a fresh temporary Agent and verify:

## Release Notes

Before tagging:

- Update user-facing docs for new setup surfaces.
- Add migration notes for config or auth behavior changes.
- Keep stale fork wording out of public docs unless the behavior exists in Fased
  code.
- Run `git status --short` and review every staged file.

Related docs:

- [Tests](/reference/test)
- [Releasing](/reference/RELEASING)
- [Security](/security)
- [API Usage and Costs](/reference/api-usage-costs)
