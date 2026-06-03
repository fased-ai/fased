# AGENTS.md

## Purpose

This file is for coding agents working in this repository.
Prioritize correctness, minimal diffs, and consistency with existing patterns.

## Repository Snapshot

- Product naming: use **FasedAgent** in prose/UI headings, and `fased` for CLI/package/paths/config keys.
- Runtime: Node `>=22.12.0`.
- Language: TypeScript (ESM), strict typing enabled.
- Main code: `src/`
- Extensions/plugins: `extensions/*`
- UI: `ui/`
- Apps: `apps/*`
- Docs: `docs/`

## Rule Files Check (Cursor / Copilot)

- No Cursor rules detected (`.cursor/rules/` or `.cursorrules`).
- No Copilot instruction file detected (`.github/copilot-instructions.md`).

If these are added later, treat them as additional constraints.

## Install / Setup

- Install deps: `pnpm install`
- Optional Bun install path: `bun install`
- Dev CLI run: `pnpm fased ...`
- Dev gateway: `pnpm gateway:dev`
- Watch gateway: `pnpm gateway:watch`

## Build / Typecheck / Lint / Format

- Build: `pnpm build`
- Fast build: `pnpm build:fast`
- Type checks (native preview): `pnpm tsgo`
- Lint: `pnpm lint`
- Lint + fix: `pnpm lint:fix`
- Format check: `pnpm format:check`
- Format write: `pnpm format` (or `pnpm format:fix`)
- Full quality gate: `pnpm check`
- Docs gate: `pnpm check:docs`
- Typical pre-push gate: `pnpm build && pnpm check && pnpm test`

## Test Commands

- Main test entry: `pnpm test`
  - Runs `scripts/test-parallel.mjs` (unit/extensions/gateway split).
- Coverage: `pnpm test:coverage`
- E2E: `pnpm test:e2e`
- Live tests: `pnpm test:live`
- Watch mode: `pnpm test:watch`
- Force-clean stuck gateway test run: `pnpm test:force`

## Running a Single Test (Important)

Use one of these patterns:

- Through project runner (preferred first try):
  - `pnpm test -- src/path/to/file.test.ts`
- Direct Vitest unit config:
  - `pnpm vitest run --config vitest.unit.config.ts src/path/to/file.test.ts`
- Single test by name:
  - `pnpm vitest run --config vitest.unit.config.ts src/path/to/file.test.ts -t "test name"`
- Single E2E file:
  - `pnpm vitest run --config vitest.e2e.config.ts test/path/to/file.e2e.test.ts`
- Single live file:
  - `FASED_LIVE_TEST=1 pnpm vitest run --config vitest.live.config.ts src/path/to/file.live.test.ts`

## Test Stability Knobs

- Lower-memory profile:
  - `FASED_TEST_PROFILE=low FASED_TEST_SERIAL_GATEWAY=1 pnpm test`
- Node vmFork override:
  - `FASED_TEST_VM_FORKS=0 pnpm test` (force forks)
  - `FASED_TEST_VM_FORKS=1 pnpm test` (force vmForks)
- E2E worker tuning:
  - `FASED_E2E_WORKERS=4 pnpm test:e2e`
  - `FASED_E2E_VERBOSE=1 pnpm test:e2e`

## Coding Style: Imports

- Use ESM imports/exports only.
- Keep imports formatted by `oxfmt` (auto-sorted; do not hand-optimize ordering).
- Prefer `import type` for type-only imports.
- Use explicit relative imports with `.js` extension in TS source (NodeNext style), matching existing files.
- Keep path aliases limited to established ones (for example `fased/plugin-sdk`).
- Do not import app-private internals across boundaries without an existing pattern.

## Coding Style: Formatting

- Formatting tool is `oxfmt`; lint tool is `oxlint`.
- Indentation: 2 spaces.
- Strings, commas, semicolons, and wrapping should follow formatter output.
- Run `pnpm format` after substantial edits.
- Keep diffs clean and avoid unrelated reformat churn.

## Coding Style: Types

- `strict` TypeScript is enabled; keep code fully typed.
- Do not add `@ts-nocheck`.
- Do not introduce `any` (rule enforced by oxlint).
- Prefer narrow types, discriminated unions, and typed function boundaries.
- Validate unknown input at boundaries (CLI args, network payloads, file reads).

## Naming Conventions

- Variables/functions: `camelCase`
- Types/interfaces/classes: `PascalCase`
- Constants: `UPPER_SNAKE_CASE` for true constants, else `camelCase` + `const`
- File names: repo favors kebab-case with dotted qualifiers where useful.
- Test files: `*.test.ts`; E2E: `*.e2e.test.ts`; live: `*.live.test.ts`

## Error Handling

- Never throw raw strings.
- Catch errors as unknown and normalize before logging or returning.
- Prefer existing helpers for formatting/redaction (for example in `src/infra/errors.ts`).
- Error messages should be actionable and safe (no secret leakage).
- Fail fast on invalid config; degrade gracefully on optional integrations where appropriate.

## Logging / Security Hygiene

- Redact secrets/tokens in logs and surfaced errors.
- Never commit real credentials, phone numbers, or private session artifacts.
- Treat inbound channel content as untrusted input.
- Follow `SECURITY.md` assumptions for trust boundaries.

## Architecture Guardrails

- Respect channel-agnostic boundaries; avoid channel-specific shortcuts in shared paths.
- When touching routing/channel/auth flows, consider built-in and extension channels.
- Keep plugin/runtime dependency boundaries intact.

## File Size / Refactoring

- Prefer small focused functions and extracted helpers over monolith edits.
- As a guideline, split files before they become hard to reason about (repo guidance targets ~500-700 LOC).
- Avoid creating duplicate "v2" files unless explicitly requested.

## Agent Workflow Expectations

- Make minimal, scoped edits.
- Do not run destructive git operations.
- Do not revert unrelated local changes.
- Run targeted tests for changed areas first, then broader suites if needed.
- In commit or PR notes, explain why the change is needed, not only what changed.
