# Lifecycle profile parity closure

Date: 2026-08-15

## Decision

Do not promote `v0.1.76-rc.96` to stable. Keep the signed-artifact plus Go
lifecycle architecture, but close the behavior gap before another candidate.
The supported public-stable bridge remains a verified-installer takeover from
the declared legacy topology and state schemas; users are not forced to erase
state or perform a fresh install.

The public managed boundary is:

1. a small verified `install.sh` acquires the pinned Go bootstrap;
2. the bootstrap verifies signed lifecycle metadata and exact artifact bytes;
3. the root-owned lifecycle host performs an inspected, journaled transaction;
4. the application, Gateway, and signer run under their declared non-root
   identities;
5. `fased update` uses the installed Go lifecycle and converges to `Already
current` on repetition.

Node and pnpm remain private build inputs. npm is not a managed install, update,
publication, or acceptance authority.

## Current evidence

| Predicate                                         | Status       | Meaning                                                                                                                                                                    |
| ------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaged rc.96 fresh Local replay                 | `PASS`       | Candidate bytes completed the isolated Local fixture.                                                                                                                      |
| Packaged v0.1.75-to-rc.96 replay                  | `SUPPORTING` | A restored predecessor capsule completed verified-installer takeover; it is not authentic public predecessor acquisition or literal owner acceptance.                      |
| Owner-Local rc.96 runtime, identities, and health | `PASS`       | Controller is root-owned; Gateway and signer use isolated identities; Gateway is loopback-only; exact generation executables are active.                                   |
| Owner-Local explicit beta update                  | `PASS`       | Two identical `fased update --channel beta` commands returned `Already current`; captured state, generation, Gateway/signer identity, and socket ownership were preserved. |
| Owner-Local bare update                           | `FAIL`       | `fased update` forgot the installed beta channel, defaulted to stable, and failed on a missing stable root-head.                                                           |
| Already-current zero-mutation                     | `FAIL`       | Each explicit beta no-op stopped and restarted the lifecycle supervisor even though Gateway/signer and declared state were preserved.                                      |
| Fresh Hosting fixture                             | `SUPPORTING` | The fixture supplied a fake Tailscale binary and did not prove host-security provisioning.                                                                                 |
| Real Hosting                                      | `NOT RUN`    | Remote VPS mutation remains owner-controlled.                                                                                                                              |
| Stable promotion                                  | `BLOCKED`    | Profile parity and authentic acceptance are incomplete.                                                                                                                    |

“Replay” means the immutable candidate bytes were re-exercised by a corrected
test/verifier on an isolated runner. Replay does not update the owner machine,
prove a real VPS, or convert synthetic acquisition into authentic acquisition.

## Unreleased closure branch status

The branch is local source evidence only. It has not been installed on the
owner Local instance, pushed, tagged, published, or run on the remote VPS.

Implemented and focused-test green:

- root-owned update-channel policy and a true already-current fast path;
- immutable-generation Gateway service-audit recognition;
- a machine-readable managed-authority matrix that keeps incomplete profiles
  as release blockers;
- an exclusive, journaled Hosting host-security transaction with recovery;
- official repository-based Tailscale installation with bounded downloads,
  root-owned auth-key file support, interactive browser authentication, and
  automatic DNS/version discovery;
- private Tailscale Serve with Funnel rejection and a rollback snapshot written
  before mutation;
- root-owned signer WebAuthn RP/origin persistence, generated signer-unit
  binding, and exact rollback;
- legacy schema-2 Hosting takeover only when the live firewall, effective SSH
  policy, fail2ban, automatic updates, signer, Tailscale identity, Serve route,
  RP identity, and no-sudo boundary still agree;
- staged nftables, SSH, fail2ban, and automatic-update hardening that keeps
  provider SSH open until the owner confirms an independent Tailscale SSH test;
- root receipt, secure bounded log, transaction lock, package/repository
  rollback, and crash-resume regressions;
- Linux/WSL2 systemd preflight that rejects WSL1 and WSL2 without systemd.

Focused Go and TypeScript tests pass, including the complete Go module outside
the desktop sandbox. Managed repair now regenerates exact
current units and projections without selecting a release or changing a
generation. Managed uninstall has a monotonic Go recovery journal, restores
only the first-install Hosting controls recorded in a write-once ownership
baseline, removes exact generated units and executable generations, and
preserves owner configuration, workspaces, signer custody, and durable account
identity by default. Both remain `partial` until command-backed root/systemd
proof passes.

Explicit rollback is now source-complete for the bounded active/previous
generation window. It requires a root-owned, mode-0600, short-lived
threshold-signed authorization that binds the exact current and target
generation, manifest digest, sequence, and epoch. The currently witnessed root
is re-resolved before the request and its revocations remain authoritative. A
normal update still refuses downgrade. The daemon accepts rollback only from a
root peer and records the authorization digest in its durable transaction.

Successful transaction finalization now prunes executable generations outside
the committed active/previous window after validating every directory and both
manifest-bound pointers. It then removes dependency layers not referenced by
either retained generation, after validating the complete dependency root and
each immutable identity marker before the first deletion. Abandoned bounded
import directories are also removed. After the complete lifecycle and Hosting
handoff commit, the bootstrap validates the entire verified-acquisition inbox
before removing any object; a failed transaction or unexpected entry preserves
all evidence. All pruning passes are fail-closed and crash-retryable. Rollback
and storage pruning remain `partial` until command-backed root/systemd proof
passes.

The application mutation boundary is also fenced: a Go-managed runtime cannot
fall back to a Node-owned Gateway service, mutate Tailscale Serve/Funnel, retry
those operations through `sudo`, source-build a replacement signer, or use the
legacy application uninstaller. Developer/source service management and
independent unprivileged plugin tooling remain available outside the managed
runtime.

The complete Go module passed outside the restricted desktop sandbox, including
the Unix peer-credential tests. The separate root/systemd T2 is `BLOCKED` in
this process because `sudo -n` reports that a password is required; no product
mutation was attempted. Real systemd Hosting, rollback/retry, WSL2, native
Darwin, command-backed repair/uninstall, complete `LOCAL0`, and owner acceptance
remain open.

## Parity gaps

### Local

Linux Local is substantially under the Go lifecycle: root owns only lifecycle
transactions; application state belongs to the local user; Gateway and signer
use isolated service identities; Gateway listens on loopback. Tailscale is not
part of ordinary Local installation. Remote Local access is a separate,
explicit post-install capability.

The application service audit did not recognize immutable Go generation
launchers and falsely reported a missing command, token, and service `PATH`.
The focused correction and regression are part of this branch.

The closure branch now persists the installed update channel as a versioned,
root-owned lifecycle policy and uses it whenever the operator does not select a
channel explicitly. Application `update.channel` is inert for managed installs.
The initialization fast path verifies signed target authority, the canonical
manifest, service convergence, and receipt before returning `Already current`;
it does not rewrite bootstrap/config/unit files, reload services, or restart
the supervisor. These are source-test `PASS` and still require unpublished
artifact and literal owner-Local proof.

### Hosting

Hosting parity was incomplete at branch start: the application could validate a
root-owned hosting-prerequisites record, but no Go participant wrote it. The
unreleased branch now supplies the source-level participant and regressions for:

- Tailscale package installation and authentication;
- automatic DNS-name discovery;
- private Tailscale Serve configuration with Funnel forbidden;
- firewall staging;
- SSH hardening with provider-access preservation;
- fail2ban;
- automatic security updates;
- exact rollback, recovery, final root-owned receipts, and signer WebAuthn
  identity.

The replacement is one typed `HostingHostSecurity` lifecycle participant with
`Inspect`, `Plan`, `Prepare`, `Verify`, `Commit`, `Abort`, and crash recovery.
Authentication secrets must come from a root-owned mode-0600 file or an
interactive browser flow and must never appear in argv, logs, or receipts.
Package-manager output goes to a bounded log while the user sees concise stages.
Provider SSH/firewall access is not disabled until independent Tailscale access
has been verified.

These rows remain `partial`, not `implemented`, until the same candidate-shaped
bytes pass the command-backed root/systemd fixtures and the owner-operated real
Hosting acceptance. Package installation may remain as benign residue after an
abort, but repository definitions, daemon enablement, authentication, Serve,
signer RP identity, firewall, SSH, fail2ban, and update-service state are restored
from the pre-mutation journal.

### Platform claims

Darwin Local now has a source-level platform identity, fixed `/Library` roots,
service-principal provisioning, exact reversible owner-home ACL handling,
launchd plist generation, service/process identity inspection, peer credential
authorization, OS-selected bootstrap/cache paths, a portable CLI launcher, and
successful Darwin arm64 cross-compilation. It remains `partial`: the public
installer and signed release index do not yet carry Darwin lifecycle host,
bootstrap, application, and dependency assets; legacy launchd takeover and a
native macOS command-backed fixture are also absent. Therefore Darwin cannot be
called migrated or accepted yet. Linux x64, Linux arm64, WSL2/systemd,
macOS/launchd, and each declared Hosting distribution require explicit adapter
and acceptance rows. A platform may be removed only through an explicit support
decision, not through a partial adapter or passing unrelated fixture.

## Why the migration drifted

The Go work replaced artifact acquisition, service generation, signer custody,
and update transactions, but profile parity was not used as the exit criterion.
Old shell responsibilities were deleted before every privileged behavior had a
Go owner. Synthetic predecessor and Tailscale fixtures were then treated too
strongly, and candidate/archive mechanics displaced authentic Local and Hosting
behavior proof.

## Complete Go-managed boundary

“Go-managed” means one owner for privileged product lifecycle mutation. It does
not mean rewriting Gateway, agent, task, Mining, or UI business logic in Go.

The Go lifecycle must exclusively own:

- release-channel policy and exact signed target selection;
- artifact, lifecycle-host, signer, and dependency acquisition/import;
- installation roots, accounts, groups, ACLs, service units, launchd/systemd
  adapters, and executable projections;
- Local and Hosting topology discovery and supported predecessor takeover;
- Gateway/signer lifecycle, quiesce, restart, health, rollback, and recovery;
- signer/Wallet custody representation migrations;
- typed configuration, identity, Wallet, Mining, federation, SQLite, and plugin
  state preservation during core update;
- immutable Fased-owned extension code and third-party plugin integrity
  boundaries;
- Hosting Tailscale, Serve, firewall, SSH, fail2ban, automatic updates, and
  host-security receipts;
- uninstall and explicit repair of a managed installation.

The application remains unprivileged and owns:

- Gateway request handling, authentication, agents, tasks, Mining behavior,
  Wallet UI/client operations, configuration UX, and health presentation;
- onboarding questions and application configuration values;
- optional Local remote-access intent, passed to a separate bounded lifecycle
  transaction when privileged mutation is required.

The following production residue must be demolished or fenced from managed
installations after equivalent adapters pass: Node onboarding service mutation,
Node Tailscale sudo fallback/Serve mutation, source-time Go installation,
legacy user-systemd/launchd gateway installation and repair, legacy signer
enrollment shell ownership, and application suggestions that invoke privileged
repair directly. Developer-source, diagnostics, mobile, SAT-maintainer, and
independent DNS/plugin tools must remain separate commands; they must not gain
access to the lifecycle root merely to remove every `sudo` string.

## Closure sequence

1. Preserve the current owner-Local fixture and close persisted-channel and
   zero-mutation `Already current` regressions found by the literal rc.96 run.
2. Keep the focused Gateway service-audit correction with its regression.
3. Add a machine-readable responsibility matrix for every supported Local and
   Hosting profile; refuse release when a required adapter or evidence row is
   empty.
4. Implement root-owned channel policy, managed uninstall/repair contracts, and
   the transactional `HostingHostSecurity` participant; remove split Node/root
   mutation authority.
5. Implement the missing Darwin/launchd boundary and prove
   all retained platform profiles.
6. Run focused tests, then build one unpublished, cached Linux-x64
   candidate-shaped artifact and run serial affected `LOCAL0` lanes.
7. Run the complete `LOCAL0` set against the identical cached artifact,
   including fresh install, stable takeover, Go-to-Go update, rollback/retry,
   restart, state/identity preservation, and repeated `Already current`.
8. Deliver one protected lifecycle-parity PR. Only after exact merged-main
   validation may a separately authorized unused candidate be allocated.
9. Treat candidate P1 as confirmation, then require authentic public
   acquisition, literal owner-Local, owner-operated real Hosting, and separate
   stable-promotion authorization.

## Future-release invariant

Compatibility is selected by profile, topology, protocol, and state-schema
identity, never by a hard-coded RC number. Every future stable release must
prove fresh install, prior supported stable takeover, current Go-to-Go update,
rollback/retry, restart, preserved state and service identities, and a repeated
identical update returning `Already current` before candidate allocation.

Gateway decomposition, Wallet/signer modularization, durable task execution,
Mining boundaries, plugin transactions, and release-automation simplification
remain separate post-lifecycle work packages. They must not be mixed into the
profile-parity correction except where a lifecycle security boundary requires
it.
