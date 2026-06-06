# Changelog

This changelog starts with the public Fased Agent release line. Required
third-party and copied-code notices are kept in [LICENSE](./LICENSE) and
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Unreleased

- No unreleased changes yet.

## 0.1.6

- Fix fresh local and hosted QuickStart onboarding so the dashboard does not
  require `fased-signerd` or native signer release assets before a wallet is
  configured.
- Clean stale local-signer socket environment from disabled wallet configs, and
  keep the managed Gateway online when signer material is not configured.

## 0.1.5

- Fix public local and VPS hosting onboarding readiness so setup finishes only
  after the Gateway, dashboard assets, WebSocket path, and Control UI boot path
  are actually usable.
- Harden hosted VPS operation around the non-root `app` runtime, loopback
  Gateway bind, root-managed `User=app` service, Tailscale Serve dashboard, and
  automatic low-memory swap/build handling.
- Fix hosted Fased Network joining and UI join/register actions, including
  handle preload, enrollment, endpoint update, and verified readiness reporting.
- Improve Control UI startup reliability with guarded boot, clearer bundle
  failure screens, hosted asset checks, and no infinite "Opening Fased Agent"
  loading state.
- Make `fased health`, `fased dashboard --no-open`, and `fased doctor` handle
  small-VPS hosted warm-up without false offline failures.
- Clarify end-user update docs: `fased update` defaults to the latest stable
  release tag, while `fased update --channel dev` or
  `git pull --ff-only origin main` is the development path.

## 0.1.4

- Prepare the public Fased Agent repository under `fased-ai/fased`.
- Align public source links, install docs, and repository metadata.
- Keep Fased-specific wallet, Fased Network, SAT mining, operator records, and
  onboarding work in the public source tree.
- Remove local proof artifacts, generated native signer binaries, and stale
  rebrand tooling from the source tree.

## 0.1.1

- Initial public Fased Agent source baseline.
