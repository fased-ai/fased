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

Streamed Hosting is fresh-install-only. Existing-host repair must reuse the
exact-tag block above and change only its final line:

```bash
bash "$BOOTSTRAP_DIR/install.sh" --repair-hosting --release "$RELEASE"
```

Use repair only when the installed updater or root-managed services cannot
recover normally. Never pipe `--repair-hosting` from mutable `main`, pass a
caller-created verified marker, or grant the operator broad sudo access.

The streamed bootstrap reports which recovery path applies:

- no persistent Fased installer state: fix the prerequisite and rerun the
  exact fresh Hosting command;
- persistent installer state: use exact-tag repair;
- working installation: reconnect as `app` and use `fased update`.

## Public modes

| Mode                 | Intended use                                        | Streamed from `main`?               |
| -------------------- | --------------------------------------------------- | ----------------------------------- |
| `--local`            | Fresh Local install on macOS, Linux, or WSL2 Ubuntu | Yes                                 |
| `--hosting`          | Fresh Hosting install on a supported systemd VPS    | Yes                                 |
| `--repair-local`     | Preserve state and repair Local runtime/service     | No normal need for root             |
| `--repair-hosting`   | Preserve state and repair Hosting runtime/services  | No; exact tagged file only          |
| `--release <vX.Y.Z>` | Select an immutable release                         | Yes, with fresh Hosting and channel |
| `--source-install`   | Developer Local source build                        | Refused for privileged Hosting      |
| `--no-onboard`       | Install runtime without onboarding                  | Local or exact tagged flows only    |
| `--verbose`          | Print command output in addition to log paths       | Yes where the selected mode permits |

Run `./install.sh --help` from a trusted checkout for the current complete
surface.

## Streamed Hosting restrictions

The streamed Hosting command accepts either `--hosting` by itself or the exact
fresh selector `--hosting --release vX.Y.Z[-prerelease] --update-channel
stable|beta`. A prerelease requires `beta`. Before tagged payload verification
it rejects:

- repair, source, invalid release/channel, and host-profile selectors;
- caller-supplied `--verified-hosting-bundle` markers;
- exported `FASED_*` values;
- proxy, custom CA, GitHub CLI config, dynamic-loader, shell-startup, and temp
  directory overrides; and
- hosts with existing Fased state, services, helpers, or installer roots.

It uses a fixed command path and locale. Before persistent Fased mutation it
verifies the offline-attested release manifest, workflow, exact tag, commit,
architecture, app/dependency/signer digests, archive paths, links, ownership,
writable modes, package version, and build identity.

## Runtime and account layout

| Identity        | Purpose                                                 | Signer access                                      |
| --------------- | ------------------------------------------------------- | -------------------------------------------------- |
| `root`          | First bootstrap and exact-tag emergency repair          | Installs isolated services; not a normal wallet UX |
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

macOS and explicitly unprotected same-user Local installs do not provide the
same operating-system isolation.

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
persistent Fased state or a specific exact-tag repair instruction.

Normal updates are transactional: the updater stages an immutable release,
checks runtime identity and health, and rolls back activation if the new
Gateway does not become healthy.

## Related

- [Install](/install)
- [VPS Hosting](/install/vps)
- [Updating](/install/updating)
- [Uninstall](/install/uninstall)
