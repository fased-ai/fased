---
summary: "Advanced installer verification, flags, restrictions, repair, and recovery."
read_when:
  - You need exact-tag pre-execution verification
  - You are repairing or automating an installation
title: "Advanced Installer Reference"
sidebarTitle: "Advanced Installer"
---

# Advanced Installer Reference

This page is for exact release selection, repair, automation, and failure
recovery. Normal users should start at [Install](/install) or
[VPS Hosting](/install/vps).

## First-execution trust boundary

The normal one-command installer is a convenience route. It downloads
`install.sh` over HTTPS from GitHub Releases and executes it before the machine
has a Fased lifecycle root. Therefore that first shell execution trusts WebPKI,
GitHub Releases, and the Fased GitHub release publisher. The digest stamped in
the shell binds the Go bootstrap downloaded afterward; it cannot authenticate
the shell itself after Bash has already started it.

The shell is intentionally small: it validates selectors and the supported
platform/architecture pair, downloads its platform-qualified stamped static Go
bootstrap, checks that digest, installs the bootstrap, and transfers control. It does not install or
build the TypeScript application, run npm/pnpm, configure services, mutate
wallet/signer state, or configure Tailscale, firewall, SSH, or fail2ban. Those
managed mutations begin only after the installed bootstrap verifies the signed
lifecycle channel and exact release descriptors.

Use the exact-tag procedure below when provenance must be verified before Bash
executes the installer. A future signed OS package or independently installed
seed verifier may provide Fased-root trust before first execution; the
convenience `curl | bash` route must never be described as providing that.

## Exact-tag pre-execution verification

This procedure authenticates a tagged `install.sh` before Bash executes it.
Install GitHub CLI from your operating system's signed package source, choose a
stable release, and replace `vX.Y.Z`:

```bash
(
set -euo pipefail
RELEASE=vX.Y.Z
BOOTSTRAP_DIR="$(mktemp -d)"
trap 'rm -rf "$BOOTSTRAP_DIR"' EXIT
chmod 0700 "$BOOTSTRAP_DIR"
curl -fsSLo "$BOOTSTRAP_DIR/install.sh" \
  "https://github.com/fased-ai/fased/releases/download/${RELEASE}/install.sh"
curl -fsSLo "$BOOTSTRAP_DIR/install.sh.attestation.json" \
  "https://github.com/fased-ai/fased/releases/download/${RELEASE}/install.sh.attestation.json"
GH_PROMPT_DISABLED=1 gh attestation verify "$BOOTSTRAP_DIR/install.sh" \
  --repo fased-ai/fased \
  --bundle "$BOOTSTRAP_DIR/install.sh.attestation.json" \
  --signer-workflow fased-ai/fased/.github/workflows/hosted-runtime-release.yml \
  --source-ref "refs/tags/${RELEASE}" \
  --deny-self-hosted-runners
chmod 0500 "$BOOTSTRAP_DIR/install.sh"
bash "$BOOTSTRAP_DIR/install.sh" --hosting --release "$RELEASE"
)
```

For a Local install, change only the final line to:

```bash
bash "$BOOTSTRAP_DIR/install.sh" --local --release "$RELEASE"
```

Stop if any download or verification step fails.

## Hosting repair and recovery

The public streamed `--hosting` entry supports both fresh installation and
existing-host recovery. From the provider root console, rerun the
[one-command Hosting bootstrap](/install/vps#3-install-fased).

It detects completed or interrupted state, verifies the immutable release
bundle and offline attestations, then invokes the internal repair selector.
Never pipe `--repair-hosting` from a branch, pass a caller-created verified
marker, or grant the operator broad sudo access. The exact-tag block above
adds pre-execution provenance verification to the immutable release entrypoint.

The streamed bootstrap reports which recovery path applies:

- no persistent Fased installer state: fix the prerequisite and rerun the
  exact fresh Hosting command;
- interrupted or persistent installer state: fix the reported problem and
  rerun the same public `--hosting` command;
- working installation: reconnect as `app` and use `fased update`.

## Public modes

| Mode                         | Intended use                                         | Entry contract                        |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------- |
| `--local`                    | Fresh supported Linux, WSL2, or macOS Local install  | Stamped release asset                 |
| `--hosting`                  | Fresh/recovering x86_64 Hosting install              | Stamped release asset                 |
| `--release <vX.Y.Z>`         | Require the same immutable release as this installer | Exact release identity                |
| `--update-channel <channel>` | Select `stable` or `beta`                            | Must match release kind               |
| `--ts-authkey-file <path>`   | Unattended Hosting Tailscale authentication          | Root-readable file; never argv secret |
| `--tailnet-access-confirmed` | Record the separate operator access ceremony         | Hosting only                          |
| `--no-onboard`               | Install runtime without onboarding                   | Supported managed profiles only       |
| `--verbose`                  | Print detailed command output                        | Explicit opt-in                       |

Run `./install.sh --help` from a trusted checkout for the current complete
surface.

## Streamed installer restrictions

The immutable release installer accepts one profile and its exact stamped
release. A prerelease requires the `beta` channel. Local accepts Linux x86_64,
Linux arm64, Ubuntu WSL2 x86_64 with systemd, and macOS x86_64/arm64 when the
release contains their platform-qualified assets. Hosting remains Linux
x86_64-only. Unstamped streamed source, unknown flags, mismatched release
selectors, unsupported platform/profile pairs, and missing native assets fail
before bootstrap acquisition or privileged mutation. Contributor checkouts
enter the explicit `scripts/install-development.sh` source workflow instead.

After transfer, the bootstrap verifies signed channel/root metadata, exact tag,
commit, architecture, app/dependency/signer digests, archive paths, ownership,
writable modes, package version, and build identity before activation.

## Runtime and account layout

| Identity        | Purpose                                                 | Signer access                                      |
| --------------- | ------------------------------------------------------- | -------------------------------------------------- |
| `root`          | First bootstrap and one-time controller recovery        | Installs isolated services; not a normal wallet UX |
| `app`           | Human operator SSH and native wallet lifecycle commands | Restricted `/run/fased-signerd/operator.sock`      |
| `fased-gateway` | Gateway service                                         | Application operations only through `app.sock`     |
| `fased-signer`  | Native signer service                                   | Owns keys, policy, network state, and audit        |

Protected Local Linux uses the same authority model with random per-profile
service identities and socket paths. Normal `fased wallet` commands route
create, import, readiness, policy, RPC, and Mining retirement through the typed
native operator client. Recovery, raw export, re-encryption, WebAuthn
enrollment, and mutating rotation are intentionally unavailable on the
operator socket; use the installed bounded signer-owner helper after normal OS
administrator authorization.

Ubuntu WSL2 x86_64 Local reuses this Linux lifecycle when systemd is active and
state remains under the WSL Linux `/home` filesystem. Linux arm64 Local uses
its separately attested native artifact set. macOS Local selects separately
attested Darwin x86_64 or arm64 assets and system LaunchDaemons. Native Windows
remains deferred; source or companion-app code does not imply managed support.

## Wallet setup contract

- The operator chooses `agent`, `mining`, or `vault`; the role is permanent.
- Create/import/recovery installs signer-owned role baseline v1 and one verified
  primary RPC as one resumable lifecycle.
- New Agent and Vault wallets are ready for reviewed owner actions. Automation
  still needs explicit caps, destinations, programs, and grants.
- New Mining wallets become SAT-ready only when the release-bound SAT manifest
  is verified; funding is still required.
- Existing legacy deny-all wallets are never expanded silently. Review the role
  and explicitly run `fased wallet policy activate-role-baseline ... --confirm`.
- Creating an Agent wallet does not silently make it the Default Agent wallet.

See [Wallet CLI](/cli/wallet), [roles and policies](/plugins/crypto/wallet-roles-and-policies),
and [wallet selection](/plugins/crypto/wallet-selection-contract).

## Environment variables

The following are advanced Local or trusted-file controls. Exported `FASED_*`
variables are rejected by the normal streamed Hosting path.

| Variable                     | Purpose                                                           |
| ---------------------------- | ----------------------------------------------------------------- |
| `FASED_INSTALL_DIR`          | Local checkout/install directory                                  |
| `FASED_STATE_DIR`            | Runtime config, sessions, credentials, logs, wallets, and caches  |
| `FASED_CONFIG_PATH`          | Explicit configuration file                                       |
| `FASED_CLI_BIN_DIR`          | Local CLI launcher directory                                      |
| `FASED_INSTALL_VERBOSE=1`    | Show command output                                               |
| `FASED_EXISTING_DATA_ACTION` | Advanced Local `keep`, `reset-config`, or `separate-state` choice |
| `FASED_EXISTING_DATA_DIR`    | State directory for a separate-state Local install                |
| `FASED_SAT_RUNTIME_ENV_FILE` | Explicit test or verified recovery SAT runtime manifest source    |

Do not place wallet keys, recovery passwords, Tailscale secrets, or provider
credentials in environment variables, command arguments, chat, or browser
requests.

## Exit and recovery behavior

The installer stops on failed prerequisite, attestation, digest, archive,
identity, service-health, or updater checks. Hosting activation is staged and
locked; failure cleanup removes temporary extraction and leaves either no
persistent Fased state or an instruction to rerun the same public `--hosting`
command from the provider root console.

Normal updates are transactional: the updater stages an immutable release,
checks runtime identity and health, and rolls back activation if the new
Gateway does not become healthy.

## Related

- [Install](/install)
- [VPS Hosting](/install/vps)
- [Updating](/install/updating)
- [Uninstall](/install/uninstall)
