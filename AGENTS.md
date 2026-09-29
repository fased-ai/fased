# Fased contributor notes

- Product name: FasedAgent; CLI/package/config: `fased`.
- Node >=22.12, pnpm, strict TypeScript ESM; relative imports use `.js`.
- Keep plugin/runtime and channel boundaries intact; do not weaken types or
  expose secrets. Preserve existing `SECURITY.md` custody assumptions.
- Tests: nearest `pnpm vitest run --config vitest.unit.config.ts <file>`;
  use the E2E config only for E2E files. Go changes use the affected package.
- Select pre-push checks with `scripts/gate-authority.mjs`.
  Use oxfmt/oxlint on changed files; no default build/full-suite run.
- Commands and dependencies live in `package.json`; inspect only what is needed.

## Git delivery

- Preserve unrelated work; use the existing task branch/PR when one exists.
- Run focused changed-surface checks and `git diff --check`; do not bypass hooks
  or branch protection. Fix actual CI failures on the same PR.
- Merge only the authorized exact passing head, then read back canonical state.
  Push/PR authority does not imply release, deployment or live-action authority.
- Questions are read-only. No mandatory model, orchestration or skill chain.
