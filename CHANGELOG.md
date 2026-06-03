# Changelog

This changelog starts with the public Fased Agent release line. Required
third-party and copied-code notices are kept in [LICENSE](./LICENSE) and
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Unreleased

- Add the Agent > Tasks ledger-backed workflow layer: webhook triggers, source
  task records, graph workflow review, approval/resume, and source-specific
  task actions now share one audit/work surface.
- Polish the Agent > Tasks workflow UI with template preview modals, source
  badges, explicit Preview/Use actions, graph run-state review, and clearer
  graph linking/zoom controls.
- Add browser E2E coverage for the webhook -> task ledger -> workflow review ->
  approval resume path, plus a composite ledger smoke across task sources.
- Clarify SAT startup guidance: Fased Agent can run without SAT, while SAT is
  the operator asset for mining, bond, and higher-trust network participation.
- Keep the release gate clean for this slice with `pnpm test:fast`,
  `pnpm ui:build`, `pnpm exec tsc --noEmit`, `pnpm check:docs`, and the
  Control UI workflow browser smoke.
- Prepare the public Fased Agent repository under `fased-ai/fased`.
- Align public source links, install docs, and repository metadata.
- Keep Fased-specific wallet, Fased Network, SAT mining, operator records, and
  onboarding work in the public source tree.
- Remove local proof artifacts, generated native signer binaries, and stale
  rebrand tooling from the source tree.

## 0.1.1

- Initial public Fased Agent source baseline.
