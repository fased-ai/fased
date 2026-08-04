# Changelog

This changelog starts with the public Fased Agent release line. Required
third-party and copied-code notices are kept in [LICENSE](./LICENSE) and
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## 0.1.76-rc.38

- Validate protected Local fresh installation and packaged update through the
  exact release artifact selected by focused CI.
- Route immutable predecessor bundles by their own release identity so legacy
  update fixtures cannot accidentally bootstrap the candidate generation.
- Preserve owner wallet state explicitly while proving rollback, retry,
  restart recovery, and idempotent repeated update behavior.

## 0.1.76-rc.37

- Make lifecycle compatibility validation version-neutral by classifying
  historical releases through persisted topology, protocol, and schema
  families instead of hard-coded release-specific update behavior.
- Keep ordinary pull-request CI focused while preserving exact Git-history,
  artifact-inventory, rollback, retry, and state-preservation release gates.
- Package the merged Local-update compatibility correction proven by PR #278;
  candidate acceptance still requires the immutable packaged transaction and
  literal owner-Local update.

## 0.1.76-rc.36

- Accept legacy Gateway readiness payloads during protected Local recovery
  while retaining strict validation for newer readiness metadata.
- Preserve exact durable generation binding when older Gateway processes omit
  generation and start-time fields.

## 0.1.76-rc.35

- Remediate the bounded release-blocking `fast-uri`, `ip-address`, and Undici
  advisories while preserving exact dependency and engine alignment.
- Align public dependency-remediation CI with the trusted private authority so
  focused advisory fixes run frozen-lockfile and production-audit gates only.
- Package the exact merged dependency tree proven by PR #273; RC34 remains an
  immutable predecessor and is not modified by this candidate.

## 0.1.76-rc.34

- Preserve the protected Local privilege boundary while staging legacy updater
  adoption through a separately executable, digest-verified client path.
- Converge incomplete legacy updater dependencies and shared Wallet, Mining,
  and application-state permissions during the standard Local bootstrap.
- Resolve the root-controlled system Node.js runtime before release identity
  inspection, and route focused CI through the exact trusted change class.
- Package the exact Local-update correction proven by PR #266; RC33 remains an
  immutable predecessor and is not modified by this candidate.

## 0.1.76-rc.33

- Bind GitHub release-gate status identity to the exact commit-status API URL
  that GitHub actually returns, while retaining the exact commit and artifact
  set binding in the status target.
- Reject wrong-commit status records without depending on the absent `sha`
  field in GitHub commit-status list responses.
- Package the focused release-infrastructure correction proven by PR #261;
  RC32 remains an immutable failed candidate with no published release assets.

## 0.1.76-rc.32

- Build and attest the complete immutable Hosting/application/signer candidate
  set without exposing a GitHub prerelease from the tag-triggered workflow.
- Promote only the exact candidate run authorized by the private release gate,
  then verify every remote asset name, size, and digest before exposure.
- Package the exact release-infrastructure tree proven by PR #259; stable
  promotion remains blocked until the independent acceptance gates pass.

## 0.1.76-rc.31

- Bind Local update readiness to the exact target generation, including final
  application, dependency, configuration, plugin, signer, and transaction
  identities after startup recovery completes.
- Prevent an early shared health cache or reachable port from committing an
  incomplete target generation, while preserving transactional rollback and
  same-command retry behavior.
- Package the exact tree proven by PR #255 for literal existing Local update
  acceptance; stable promotion remains blocked until that command passes.

## 0.1.76-rc.30

- Keep the privileged Local supervisor and controller tree private while
  exposing only the digest-verified updater client from a separate executable
  root-owned path.
- Transactionally converge partial protected Local updater layouts, stale user
  journals, service activation, and rollback without changing Wallet, signer,
  Mining, Network, or plugin state.
- Package the exact tree proven by PR #253 for literal Local acceptance; stable
  promotion remains blocked until the public install and update commands pass.

## 0.1.76-rc.29

- Centralize Local and Hosting recovery under the stable privileged lifecycle
  supervisor, with topology-neutral controller handoff and retry behavior.
- Preserve service ownership, Gateway recovery, plugin health state, and exact
  controller receipts across interrupted update, rollback, reboot, and retry.
- Package the exact tree proven by PR #250 for literal Local and VPS acceptance;
  stable promotion remains blocked until those public commands pass.

## 0.1.76-rc.28

- Keep lifecycle-controller generation staging and rollback under the stable
  privileged supervisor instead of the replaceable target controller.
- Bind supervised controller handoff to verified release identity and prevent
  the application worker from mutating privileged controller state.
- Package the merged correction from PR #248 for literal Local and Hosting
  acceptance; stable promotion remains blocked until those commands pass.

## 0.1.76-rc.27

- Promote verified lifecycle-supervisor and controller generations atomically
  for Protected Local and Hosting installations, with exact crash recovery and
  rollback to the previously serving Gateway.
- Publish complete owner-only update locks atomically so concurrent updater
  processes cannot enter the same signer transaction.
- Package the fully green correction from PR #246 for literal owner-Local and
  VPS acceptance; stable promotion remains blocked until those commands pass.

## 0.1.76-rc.26

- Validate an installed lifecycle controller against its persisted identity
  independently from deciding whether it already matches the update target.
- Support real controller generation A to B transitions while preserving exact
  application and controller rollback, same-command retry, and idempotence.
- Package the correction from PR #244 for literal owner-Local update acceptance;
  stable promotion remains blocked until that ordinary update passes.

## 0.1.76-rc.25

- Repair incomplete Protected Local forward-update authority through the
  ordinary update path without introducing another repair command.
- Preserve the restored Gateway service owner across rollback and require its
  exact runtime identity and health before accepting recovery.
- Package the correction from PR #242 for ordered Local and Hosting lifecycle
  acceptance; stable promotion remains blocked until those gates pass.

## 0.1.76-rc.24

- Preserve permanent per-Wallet Mining history and complete target-owned
  updater generations from the RC23 source candidate.
- Make tagged release validation fetch the immutable historical updater
  fixture required to prove older-updater rollback and same-command retry.
- Keep Local-fresh, Local-update, and Hosting lifecycle acceptance ordered and
  block stable publication until external acceptance and Section 19 close.

## 0.1.76-rc.23

- Preserve permanent per-Wallet Mining history in a scalable SQLite/WAL
  ledger, including transactional migration of accumulated legacy history.
- Promote complete target-owned updater generations atomically while
  preserving large declared state through failure, rollback, and same-command
  retry.
- Scope Local-fresh, Local-update, and Hosting lifecycle CI independently so
  release checks reuse exact artifacts without unrelated rebuilds.

## 0.1.76-rc.22

- Build and release the Go signer with Go 1.25.12, eliminating the reachable
  standard-library vulnerabilities reported against the previous toolchain.
- Pin signer build identities and protected-update fixtures to the exact
  candidate used for release validation.
- Keep installer, onboarding, and update requirements aligned with the
  enforced signer toolchain.

## 0.1.76-rc.21

- Establish the version-neutral lifecycle supervisor and target-controller
  handoff for supported Local and Hosting topologies.
- Verify release trust with threshold-signed metadata, provenance, SBOM/VEX,
  revocation, expiry, architecture, and compatibility policy.
- Converge fresh installation, update, rollback, retry, signer, Wallet,
  Mining, federation, plugin, and shared-state transactions under one
  official candidate identity.

## 0.1.76-rc.20

- Make managed Local and Hosting bootstrap, target-controller handoff, and
  interrupted retry version-neutral across supported lifecycle boundaries.
- Preserve declared shared-state access and safely tolerate fresh state roots
  through activation, rollback, and same-command retry.
- Require an exact-candidate Local update, rollback, retry, and idempotence
  lifecycle gate in pull-request CI.

## 0.1.76-rc.19

- Converge protected Local update activation under the target controller,
  including legacy restart handoff, rollback, and same-command retry.
- Preserve Gateway, identity, Wallet, and Mining access by reconciling only
  declared shared-state permissions during install and update.
- Bind application, signer, controller, and lifecycle fixtures to the exact
  candidate commit while isolating unpublished same-version generations.

## 0.1.76-rc.18

- Converge protected Local and Hosting controller permissions transactionally
  while preserving the prior installation automatically on failure.
- Keep protected Gateway device authentication, Mining history, signer
  diagnostics, and plugin diagnostics operational after install and update.
- Add owner-Local candidate gates that exercise the installed controller,
  application, Mining, signer, and plugin boundaries before release work.

## 0.1.76-rc.17

- Add one verified root bootstrap path that detects and transactionally
  migrates legacy Hosting controller, signer, Gateway, wallet, and persistent
  state before returning later updates to the ordinary `fased update` flow.
- Keep failed legacy Hosting recovery on the prior working installation with
  automatic rollback and actionable operator guidance.

## 0.1.76-rc.16

- Converge fresh and existing Local and Hosting installation lifecycles on the
  exact target-owned controller, signer, Gateway, and rollback transaction.
- Preserve wallet, device-auth, and federation state permissions across the
  protected operator and Gateway service identities.
- Keep installer output operator-focused with one final dashboard URL and no
  internal transaction or duplicate readiness output.

## 0.1.76-rc.15

- Reuse green pull-request checks when merged main has the exact tested tree,
  avoiding a duplicate full release matrix after squash merge.
- Build one exact Protected Local fixture artifact and reuse it across parallel
  Ubuntu and Rocky lifecycle checks.
- Keep version-only release work limited to lightweight version and release
  identity validation.

## 0.1.76-rc.14

- Complete Protected Local fresh-install and migration acceptance on Ubuntu and
  Rocky, including rollback, retry, restart, reboot, and wallet-state
  preservation.
- Finish the root-to-app Hosting handoff without duplicate Tailscale setup,
  premature state access, or misleading streamed-installer failures.
- Recognize the root-managed Hosting Gateway service and shared state correctly
  in Doctor and service-readiness checks.

## 0.1.76-rc.13

- Keep anonymous Local release resolution bound to one exact attested commit
  even when verification tools must be installed first.
- Fence active and queued legacy Gateway starts before Protected Local
  migration, preserving transactional rollback, retry, and wallet state.

## 0.1.76-rc.12

- Preserve the operator home owner, group, mode, and existing POSIX ACL while
  granting only the dedicated Protected Local Gateway UID traversal access.
- Restore the exact prior ACL on rollback and wait for the legacy user Gateway
  to become inactive before protected service migration continues.

## 0.1.76-rc.11

- Prevent legacy Local Gateway services and their reverse-dependent timers from
  reclaiming the Gateway port during protected service migration.
- Preserve and restore the exact legacy user-service topology transactionally
  across target activation failure, rollback, and normal update retry.

## 0.1.76-rc.10

- Preserve root-established Protected Local shared-state ownership and modes
  after activation so the dedicated Gateway retains required state access.
- Persist the selected update channel before Protected Local Gateway activation
  to avoid a post-activation configuration-watcher restart.

## 0.1.76-rc.9

- Normalize root-controlled Protected Local runtime and release-directory
  traversal before service activation, including under the controller's
  restrictive umask.
- Verify the selected application runtime as the dedicated Gateway user before
  state migration or service activation.

## 0.1.76-rc.8

- Complete Protected Local fresh-install and legacy-update acceptance with
  transactional root-service migration, rollback, retry, restart, and reboot
  coverage.
- Preserve user-owned Local configuration while converging the application,
  updater, signer, and Gateway on one exact immutable release identity.

## 0.1.76-rc.7

- Stage and verify the selected target application and recovery controller
  before Protected Local privilege migration, with exact rollback and
  converged application, updater, signer, and service identities.
- Repair streamed and standalone Local installer handoff, protected runtime
  traversal, and packaged Gateway health detection.

## 0.1.76-rc.6

- Bound Protected Local Gateway health checks within the update transaction so
  rollback and retry remain available, and add portable Linux/macOS signer and
  Local lifecycle coverage.
- Update the production PostCSS override to patched `8.5.18`.

## 0.1.76-rc.5

- Repair Protected Local migration for the exact legacy signer/enrollment
  hard-link pair while keeping unexpected additional hard links fail-closed.
- Keep interactive streamed Hosting onboarding attached to the provider
  console and fail early when a fresh interactive install has no controlling
  terminal.

## 0.1.76-rc.4

- Unify Local and Hosting on the protected Go signer lifecycle, including
  published-updater handoff, root-controlled activation, and exact
  application/signer release identity.
- Add real-systemd Ubuntu and Rocky fixtures for fresh install, legacy Local
  migration, wallet and Gateway operation, injected failure, rollback, retry,
  restart, and reboot persistence.

## 0.1.76-rc.3

- Accept complete multiline Tailscale Serve status output, including trailing
  informational lines, while still requiring the exact loopback Gateway route.
- Scope GitHub validation and release workflows to the affected product
  surfaces so Hosting-only corrections avoid unrelated Docker and product
  matrices.

## 0.1.76-rc.2

- Keep the root-authorized signer operator socket active through the complete
  Hosting wallet onboarding and signer readiness flow, then persist the
  restricted application socket for normal Gateway runtime.
- Add integrated coverage for the Hosting root-to-app signer socket handoff.

## 0.1.76-rc.1

- Complete the authenticated Hosting lifecycle handoff between the root
  controller and application runtime while preserving updater, signer, state,
  restart, readiness, and rollback coordination.
- Restore the complete security-audit implementation and route its full
  80-case contract through canonical local and GitHub test execution.
- Correct deep Gateway probe credentials and browser-container audit wiring so
  release validation exercises the deployed behavior instead of silent gaps.

## 0.1.75

- Make the Hosting root controller update itself transactionally so existing
  installations receive future controller fixes without manual repair.
- Verify anonymous Hosting installer, signer, controller, and manifest assets
  from published offline attestation bundles without requiring GitHub login.
- Add a non-latest beta channel and prerelease classification checks so Local
  and Hosting release-candidate updates can be exercised before a stable tag.

## 0.1.74

- Repair interrupted and mixed-state Local updates so one normal
  `fased update` can retain the verified forward controller, restore the
  previous application/signer pair on failure, and retry safely.
- Make update status report the active application, signer, and last-success
  identities truthfully instead of treating a matching source tag as complete.
- Add an on-demand pre-release Docker gate that executes native AMD64 and ARM64
  signer images before a stable tag without publishing candidate images.

## 0.1.73

- Repair normal Local source updates from v0.1.72 by validating the candidate
  signer in its writable release location and preserving the rollback
  controller needed to restore paired application and signer state.
- Keep Docker runtime images free of pnpm and npm caches, and patch audited
  production dependencies without changing tolerant image-decoding behavior.
- Preserve the faster native-architecture Docker and sharded release checks
  while enforcing clean-image and updater-compatibility release gates.

## 0.1.72

- Fix the ARM64 Docker release image so it contains and executes the native
  ARM64 signer instead of an AMD64 binary.
- Add a native ARM64 pre-release signer gate and shorten release CI by
  sharding the long Gateway and extension test lanes.
- Avoid repeated Hosted release validation in each architecture build while
  preserving the canonical self-validating artifact command.

## 0.1.71

- Restore the final pull-request dependency audit and make the A2A HTTP timing
  coverage deterministic under concurrent CI load.
- Run Docker vulnerability scanning with a scanner binary matching each native
  AMD64 or ARM64 release runner so multi-architecture publication remains
  portable and fully validated.
- Update DOMPurify to the audited patch release so the production dependency
  graph contains no known vulnerabilities at release time.

## 0.1.70

- Make Local wallet and Go signer migration transactional and automatic during
  normal updates while preserving wallet identities, RPC state, role baselines,
  and rollback state.
- Align Control UI and onboarding wallet names, generated IDs, handles, RPC
  editing, balances, routing, reviewed approvals, optional passkeys, activity,
  archive controls, and restart persistence.
- Repair anonymous native-signer installation, managed runtime profiles, and
  the verified streamed Hosting bootstrap used by fresh and updating installs.
- Reconcile Pi 0.80 APIs across core and plugin boundaries so the full strict
  TypeScript check passes without a dependency downgrade.
- Parallelize CI validation, reuse build artifacts, use native ARM64 Docker
  runners and caches, and publish concise Local/Hosting wallet documentation.

## 0.1.69

- Make new signer-owned Agent, Mining, and Vault wallets role-ready with one
  verified RPC; preserve legacy deny-all wallets until explicit activation.
- Make Agent wallet routing explicit, then skill-specific, Agent-specific, and
  finally optional Default Agent fallback; creation never selects a fallback.
- Separate the Hosting operator, Gateway, and signer identities; provide the
  same native wallet lifecycle on Local and Hosting without ordinary root
  helper commands.
- Add signer-tombstoned, resumable Mining retirement and a distinct role-ready
  successor.
- Restore the exact fresh streamed Hosting command with verified tagged
  handoff, retain exact-tag-only repair, and reset English/Chinese install and
  wallet documentation around the tested behavior.

## 0.1.68

- Unify signer-owned Agent, Mining, and Vault creation around one explicit role
  and one primary Solana RPC across terminal onboarding, CLI, Control UI, Local,
  and Hosting, with automatic signer network activation and role-safe readiness.
- Add encrypted native recovery, advanced owner-only raw export, guarded Mining
  archive/replacement, receive QR, RPC editing, and hardened verified Hosting
  installation without exposing signer custody controls to Gateway.
- Bridge managed Local updates from v0.1.67 with a legacy schema-v1 app layer,
  while Hosting and current clients select the commit-bound schema-v2 app and
  signer through the unified attested release manifest.

## 0.1.67

- Reject native Windows npm installs at package selection and fail closed at
  the launcher and central runtime guard; Windows Local remains supported
  through Ubuntu on WSL2.

## 0.1.66

- Keep normal wallet onboarding to wallet role plus one primary Solana RPC,
  infer the supported cluster from its genesis hash, and reserve an optional
  second full execution RPC for advanced failover.
- Separate signer execution RPCs from the verification-only public witness;
  pin same-genesis configuration and confine public agreement to sensitive
  address lookup-table account bytes and slots.
- Complete signer-owned typed lookup-table lifecycle, durable forward/reverse
  bindings and mutation leases, exact-byte replay, effect reconciliation,
  collision recovery, stale-reservation fencing, and cleanup recovery.
- Make the short Hosting installer bootstrap an exact immutable release before
  privileged execution, preserve the root signer-control boundary, and retain
  the advanced manually attested installation path.
- Show unpaid keeper bounty in the live Mining current-cycle card and preserve
  it across refresh and reconciliation.

## 0.1.65

- Add rent-aware SAT settlement accounting, durable submission serialization
  and reconciliation, keeper-bounty debt visibility, and operator status in the
  Mining UI and CLI surfaces.
- Add signer-owned typed address lookup-table create, extend, deactivate, close,
  and lookup-backed distribution operations with Mining-role, program, action,
  and rent policy gates; all lookup-table operations remain disabled by default.
- Require byte-identical lookup-table account state from at least two distinct
  configured RPC origins before compiling numeric v0 indexes, and fail closed
  for one provider, duplicate origins, or disagreement.
- Use independent lifecycle slot reads and the conservative lower slot for
  lookup-table activation, deactivation, and close checks.
- Preserve explicit lookup-table enablement through managed updates and document
  policy activation, rent recovery, keeper reconciliation, and rollback.

## 0.1.64

- Make protocol-v2 `fased-signerd` authoritative for native key creation,
  import, rotation, encrypted state, fail-closed wallet policy, durable caps,
  idempotency, and ambiguous-broadcast reconciliation.
- Replace the maintained Hosting broker and Gateway sudo path with an
  independent root-managed signer service, separate application/control
  sockets, verified release identity, and transactional update/rollback.
- Add typed SOL, SPL, SAT Mining, Vault bond, and federation operations with
  signer-owned semantic validation; Jupiter swaps and Trigger mutations remain
  preview-only pending live qualification.
- Move reviewed WebAuthn challenges into the signer, add Wallet Standard
  hardware and Turnkey provider flows, and keep new native wallets receive-only
  until an exact positive policy hash is acknowledged.
- Add bounded signer, A2A, Marketplace, skill, and memory state with capacity
  warnings, replay-safe retention, and complete-state archive/restore guidance.
- Document clean Linux/macOS installs, Windows 10/11 through WSL2 Ubuntu,
  independent VPS Hosting custody, Local-only Docker, wallet activation,
  Mining, Vault, updates, and recovery.

## 0.1.63

- Fix maintained Hosting first-wallet setup by launching the packaged signer
  broker through the lazy wallet CLI entry instead of importing optional
  channel dependencies from the minimal hosted runtime.
- Validate packaged signer-broker startup during hosted artifact creation and
  recognize the secured `0660` app-facing broker socket used by the isolated
  VPS signer account while retaining `0600` for single-user installs.
- Clarify that Windows runs Fased inside WSL2 Ubuntu, with PowerShell used only
  to install or manage WSL2, and document the public Docker image as a
  local-only path; maintained VPS hosting remains non-Docker.

## 0.1.62

- Install a version-matched, checksum-verified local wallet signer automatically
  when first-time wallet setup selects the local socket signer path; normal
  installs no longer require Go.
- Show automatic signer installation in both Local and Hosting QuickStart while
  keeping the redundant wallet-backend prompt hidden in the hosting profile.
- Publish static Linux and macOS signer assets for x64 and arm64 with release
  checksums, module-relative installer resolution, and clear WSL2 guidance for
  Windows users.

## 0.1.61

- Harden local Docker deployments with loopback-only published ports, dropped
  Linux capabilities, `no-new-privileges`, protected environment files, and
  explicit rejection of container-engine socket mounts.
- Validate release images as a non-root user and block images containing
  embedded secrets or fixable critical vulnerabilities.
- Publish immutable multi-architecture GHCR images only from version tags with
  SBOM and provenance metadata; keep full Docker Gateway support local-only and
  use the maintained non-Docker installer for VPS hosting.

## 0.1.36

- Ship verified hosted release artifacts for fast VPS installs and updates
  without repeating the npm dependency graph on normal releases.
- Keep dashboard chat, tasks, model providers, wallets, mining, Satcoin, and
  Fased Network in core while moving Telegram, WhatsApp, Discord, and Slack
  runtime stacks to installable add-ons.
- Add packed-core and package-budget gates plus stable runtime SDK boundaries
  so SAT mining and core startup work without optional channel packages.
- Require verified voice webhook request keys, suppress replay side effects,
  and activate the configured stale-call cleanup timer.

## 0.1.35

- Add a hosted npm update fast path that downloads the exact Fased package
  tarball and swaps package files directly when runtime dependencies did not
  change, avoiding a full npm dependency reinstall for code-only updates.
- Keep hosted updates on the safer package-manager path when dependencies do
  change, so fresh dependency graphs still install normally.
- Prepare the next release after the hosted update version-verification and
  gateway refresh fixes.

## 0.1.33

- Fix hosted VPS updates so the refreshed gateway service resolves the managed
  script from the updated npm package instead of a stale `/home/app/fased`
  checkout.
- Make managed startup prefer the updated npm runtime root before the bootstrap
  checkout, so the daemon and CLI use the same Fased version after package
  updates.
- Make hosted package update status report npm instead of the source repo
  package manager, and use cache-friendly npm install flags for package updates.
- Show gateway RPC timeout during warm-up as `warming` instead of a hard failure
  when the service is running.

## 0.1.32

- Probe the lightweight Gateway `health` RPC for gateway status checks so hosted
  VPS instances do not show a false timeout while normal gateway methods are
  already answering.

## 0.1.31

- Make gateway restart wait for the local Gateway RPC to answer instead of
  treating an open port as healthy during hosted VPS warm-up.
- Stop `fased gateway status` from reporting the expected Fased gateway
  listener as a port conflict when the gateway is still warming up.

## 0.1.18

- Remove the leftover `FASED SETUP` intro frame so onboarding begins directly
  with the first framed prompt.
- Keep the installer banner/status framing from 0.1.17 while aligning the
  published npm package with the current main branch.

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
