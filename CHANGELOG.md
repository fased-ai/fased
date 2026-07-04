# Changelog

This changelog starts with the public Fased Agent release line. Required
third-party and copied-code notices are kept in [LICENSE](./LICENSE) and
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## 0.1.17

- Frame the installer banner and top setup status so the FASED logo, version,
  mode, logs, system preparation, runtime, and interactive setup messages use
  the same terminal block style as onboarding prompts.
- Keep the existing FASED ASCII logo text while changing the installer header
  colors to gray titles/borders, yellow labels, plain values, and green status
  checkmarks.

## 0.1.16

- Restore framed wizard panels and radio/check prompt markers while keeping the
  cleaner hosted/local onboarding copy from 0.1.15.
- Standardize terminal onboarding colors so block titles and frames are gray,
  section labels are yellow, values and copyable URLs/commands/tokens are
  green, and body text remains plain.
- Separate Fased Network status labels from copyable handles/URLs so the
  summary is easier to scan during local and hosted setup.

## 0.1.15

- Clean hosted onboarding output so local-device, Tailscale, security,
  readiness, and final access blocks use one readable terminal style.
- Remove redundant hosted setup helper cards while keeping the underlying
  Gateway, systemd, Tailscale, and hardening checks active.
- Document that hosted VPS installs use the npm prebuilt runtime for speed and
  require npm `latest` to be published when a new fresh-VPS setup should see the
  newest wizard/runtime behavior.

## 0.1.14

- Clear the public-release check gate by moving ACP thread-binding channel
  details behind the channel/thread-binding layer.
- Keep Satcoin live-chaos markers under the preferred Fased temp root unless an
  explicit marker directory is configured.
- Fix release-readiness lint and docs formatting issues found during the public
  repository hardening pass.

## 0.1.13

- Refresh the curated model catalogs for provider defaults and onboarding,
  including newer Claude Sonnet, Z.AI GLM, Qwen, Minimax, xAI, Chutes, and
  OpenCode Zen selections.
- Update vulnerable dependency pins across the runtime, UI, and bundled
  extensions, reducing npm audit output to the remaining unpatched upstream
  `@mariozechner/pi-coding-agent` advisories.
- Fix stale workspace peer package names for bundled Google Chat and Memory
  Core extensions so workspace installs resolve cleanly.

## 0.1.8

- Publish and verify the npm package as `@fased/fased@latest`; the installed
  command remains `fased`.
- Fix the npm package contents so the global CLI includes the launcher runtime,
  and add release checks for launcher packaging and brand-version drift.
- Clarify the public install order: curl bootstrap for fresh local/VPS installs,
  npm package for users who already have Node/npm, and source checkout for
  contributors.
- Expand installer portability across common Linux, VPS, FreeBSD, WSL2, and
  macOS/Homebrew host families.
- Supersede the broken `@fased/fased@0.1.7` npm package, which missed the
  launcher runtime file.

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
