---
summary: "How the repo-backed installer works (`install.sh`), plus flags and automation"
read_when:
  - You want to understand `install.sh`
  - You want to automate installs from the repo
  - You want the exact repo-backed install flow
title: "Installer Reference"
sidebarTitle: "Installer Reference"
---

# Installer Reference

This docs set only documents the installer that exists in this repo:

- [`install.sh`](https://github.com/fased-ai/fased/blob/main/install.sh)

If you are starting from zero on your own computer, use the
[verified stable Local install](#verified-stable-local-install). The shorter
command below is an interactive convenience path: after it starts, the
installer resolves the latest stable release, verifies the unified release
attestation, and checks out that exact commit. It does not provide
pre-execution verification of the first script downloaded from `main`.

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --local
```

If you are starting from zero on a VPS, use the
[pre-execution verified Hosting bootstrap](/install/vps#3-install-fased-and-connect-through-tailscale).
Ubuntu LTS is the recommended first VPS target. Never pipe an unverified
Hosting installer directly into a privileged shell.

<Warning>
On Windows 11 or Windows 10 version 2004/build 19041 or newer, open
Administrator PowerShell and run this PowerShell block:

```powershell
wsl --install -d Ubuntu
wsl --update
wsl --version
wsl --list --verbose
```

Restart if requested.
WSL must be `0.67.6` or newer with the installed distribution on version 2.
Open the Ubuntu application and run this separate Bash block inside that
Ubuntu shell:

```bash
uname -s
systemctl is-system-running || true
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --local
```

`uname -s` must print `Linux`. Do not run the Bash block or `install.sh` in
PowerShell, Command Prompt, Git Bash, or native Windows Node.js. The complete procedure is in [Windows
(WSL2)](/platforms/windows).
</Warning>

## Verified stable Local install

Use this path for a production Local, WSL2, or macOS installation that will
hold wallet credentials. Install GitHub CLI from the operating system's trusted
package source and confirm `gh version`. Choose an exact stable release from
[GitHub Releases](https://github.com/fased-ai/fased/releases), replace
`vX.Y.Z`, and run the block in macOS Terminal, a Linux terminal, or the Ubuntu
WSL2 Bash shell—not PowerShell:

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
bash "$BOOTSTRAP_DIR/install.sh" --local --release "$RELEASE"
)
```

Stop if any download or attestation check fails. The verified installer then
requires the source tag, checked-out commit, package version, native signer
identity, and signer attestation to agree. Neither the normal Local path nor
first-wallet setup requires Go.

## What `install.sh` does

<Steps>
  <Step title="Detect the host environment">
    Supports macOS, Linux, and WSL2.
  </Step>
  <Step title="Ensure a compatible Node.js runtime">
    Fased recommends Node 24 and requires Node 22.14 or newer with the built-in
    `node:sqlite` module. With auto-install enabled, the installer can install
    missing command-line tools and Node on common VPS and workstation families:
    Ubuntu, Debian, Kali, Fedora, CentOS, AlmaLinux, Rocky Linux, CloudLinux,
    Oracle Linux, Amazon Linux, openSUSE, SLES, Alpine, Arch, FreeBSD, WSL2
    Ubuntu, and macOS with Homebrew. Hosted installs may use the published
    runtime package internally so small VPS hosts can skip the slow source
    build. Source/developer installs use `pnpm` when a checkout needs to be
    built.
  </Step>
  <Step title="Ensure Git">
    Installs Git if it is missing.
  </Step>
  <Step title="Prepare the runtime">
    Uses the checkout as the update/repair anchor. For hosted installs, the
    runtime can come from the published package behind the scenes so the full
    source build is skipped.
    Current installers attempt a fast-forward-only update from `origin` before
    setup. If source changes during that update, the installer restarts once so
    the new installer code runs.

    Local installs check for existing `~/.fased` data before onboarding. If
    state already exists, the installer asks whether to keep it, reset local
    config metadata, or use a separate state directory for this checkout.

    If the install starts as `root` on a hosted server, the installer creates a
    non-root `app` user, prepares `/home/app/fased`, and re-runs itself there.
    The runtime and CLI are then owned by `app`.

  </Step>
  <Step title="Install the CLI launcher">
    Installs the repo-backed `fased` command into the user command path and
    verifies it before onboarding.

    By default this is `${FASED_CLI_BIN_DIR:-$HOME/.local/bin}/fased`; the
    installer also tries to add that directory to common shell startup files.

  </Step>
  <Step title="Run onboarding when appropriate">
    If onboarding is enabled, the installer hands off to `fased onboard --install-daemon`.
    On low-memory Linux hosts, the installer creates swap automatically when
    possible and onboarding runs with a larger V8 heap limit. Override with
    `FASED_ONBOARD_MAX_OLD_SPACE_MB` only for troubleshooting.

    For a hosted or VPS runtime, the intended sequence is:

    1. install/sign into Tailscale on your own computer
    2. run the hosted installer on the VPS
    3. approve the Tailscale login URL printed by Fased
    4. when prompted, test the access command from your own computer:
       `ssh app@YOUR_VPS_TAILSCALE_NAME` when app keys exist, or
       `tailscale ssh app@YOUR_VPS_TAILSCALE_NAME` for root/password-only bootstrap
    5. use the SSH public key fallback only if Tailscale SSH is unavailable
    6. confirm only after SSH reaches `/home/app/fased`
    7. open the printed Tailscale dashboard URL in your local browser
    8. save the gateway token in case the browser asks for it
    9. reconnect as the non-root `app` user over the Tailscale network for CLI work
    10. keep admin access private through Tailscale instead of opening the gateway directly

    Root is the bootstrap/emergency shell. After hosted onboarding completes,
    normal commands run as `app`; the shell starts in `/home/app/fased`:

    ```bash
    ssh app@YOUR_VPS_TAILSCALE_NAME
    fased status
    fased dashboard
    ```

    Hosted VPS setup uses the root-managed `fased-gateway.service`, and that
    service runs as the non-root `app` user. It should not ask for the `app`
    password to run `sudo loginctl enable-linger app`.

    Non-interactive automation must only set
    `FASED_HOSTING_TAILNET_SSH_CONFIRMED=1` after an out-of-band check proves the
    `app` SSH path over Tailscale works. Without that explicit confirmation,
    hosting setup stops before SSH/firewall lock-down.

  </Step>
  <Step title="Leave SAT IDs for Sync">
    Pre-launch installs keep `config/sat-runtime.env` empty. After Satcoin
    mainnet launch proof is published, use Mining Sync to verify the signed
    manifest and write the official SAT runtime IDs.
  </Step>
</Steps>

## Quick commands

From the repo root:

```bash
./install.sh
```

```bash
./install.sh --help
```

```bash
./install.sh --no-onboard
```

```bash
./install.sh --verbose
```

## Auto-install support

`./install.sh` uses the host's normal package manager, then verifies that Node
can load `node:sqlite` before continuing.

| System family                                            | Package manager path                                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Ubuntu, Debian, Kali, WSL2 Ubuntu                        | `apt-get` + NodeSource Node 24 when needed; distro `nodejs`/`npm` fallback on newer releases |
| Fedora                                                   | `dnf` / `dnf5`; native Node 24 package first, NodeSource fallback                            |
| CentOS, AlmaLinux, Rocky Linux, CloudLinux, Oracle Linux | `dnf` / `yum` + NodeSource Node 24 fallback                                                  |
| Amazon Linux                                             | `dnf` / `yum` + NodeSource Node 24 fallback                                                  |
| openSUSE, SLES                                           | `zypper` packages, then runtime verification                                                 |
| Alpine                                                   | `apk` packages, then runtime verification                                                    |
| Arch                                                     | `pacman` packages, then runtime verification                                                 |
| FreeBSD                                                  | `pkg` packages, then runtime verification                                                    |
| macOS                                                    | Homebrew, if Homebrew is already installed                                                   |

If a provider image ships an old or custom Node build, the installer stops with
the exact Node problem instead of continuing with a broken runtime.

Fresh machine convenience path (not pre-execution verified):

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --local
```

Fresh VPS Hosting uses the
[pre-execution verified release-asset bootstrap](/install/vps#3-install-fased-and-connect-through-tailscale).
That procedure downloads the standalone installer and its attestation, verifies
the exact repository, tag, release workflow, and GitHub-hosted runner before
execution, and only then invokes the verified file with `--hosting`. Do not use
a raw tagged `curl | bash` command for Hosting. The installer installs/starts
Tailscale when needed and runs the browser login with timeout/readiness checks.
Automatic Hosting setup uses Tailscale's signed apt repository on Ubuntu/Debian
or its signature-enforcing RPM repository on Fedora/RHEL-family systems; it
does not execute Tailscale's remote installer script as root. Other systems
must install the official signed package first.

Hosting note:

- follow the OS-specific hosted setup in [Install](/install#vps-hosting-install)
- when Tailscale prints a login URL in SSH, open it in your local browser
- use an auth key only for unattended automation
- use the **hosting** profile in the wizard
- keep access tailnet-only unless you later make a deliberate, separately-audited exposure choice
- after hosted onboarding completes, run normal CLI/update/repair commands as
  `app` from `/home/app/fased`; root is only for first bootstrap or emergency repair

Update note:

| Command                                                 | What it gets              |
| ------------------------------------------------------- | ------------------------- |
| `git clone https://github.com/fased-ai/fased.git fased` | Latest `main` checkout    |
| `git pull --ff-only origin main`                        | Latest `main` checkout    |
| `fased update`                                          | Latest stable release tag |
| `fased update --channel dev`                            | Latest `main` checkout    |

Use `fased update` for normal end-user updates. Use `git pull --ff-only origin
main` or `fased update --channel dev` only when you intentionally want the
developer channel.

Native signer note:

- generated signer binaries are not committed to Git
- Local installs download and install the verified signer asset automatically
  when the first native wallet is created
- Hosting bootstrap installs the version-matched signer and root updater as an
  independent service before wallet selection, so first-wallet setup never
  builds Go or starts a Node broker
- both paths verify the SHA-256 checksum and GitHub release attestation; normal
  users do not install Go
- Local wallet-first setup stages the exact signer candidate in read-only mode
  while the launcher, policy helper, and templates are installed. The signer is
  promoted to read-write only after its identity, protocol, and policy state
  pass verification; a pre-commit failure restores the previous signer files
  and process state
- importing an existing account is a separate native
  `fased-signerd admin wallet import` control-socket operation; the Gateway,
  dashboard, and normal setup wizard do not accept private keys
- Local runs the signer under the same OS account. Hosting installs an
  independent root-managed systemd service under the `fased-signer` account;
  the Gateway receives only `/run/fased-signerd/app.sock` and never receives the
  control socket, signer state path, or sudo access
- a newly created signer-owned wallet starts locked with deny-all policy; signer
  service readiness is not wallet send readiness. Configure both RPC planes,
  activate an owner-reviewed role policy, verify exact hashes, and enroll signer
  WebAuthn before manual reviewed execution or funding
- supported signer platforms are Linux and macOS on `amd64` or `arm64`; Windows
  users must run Fased inside WSL2, which receives the Linux asset
- `FASED_WALLET_LOCAL_SIGNER_BIN`, `FASED_LOCAL_SIGNER_VERSION`, and
  `FASED_LOCAL_SIGNER_BASE_URL` remain advanced overrides
- a failed official asset, checksum, or attestation is fatal; source builds
  require the explicit developer option

## Common modes

<Tabs>
  <Tab title="Default">
    ```bash
    ./install.sh
    ```

    Runs onboarding by default.

  </Tab>
  <Tab title="Skip onboarding">
    ```bash
    ./install.sh --no-onboard
    ```
  </Tab>
  <Tab title="Hosting profile">
    Follow the exact
    [pre-execution verified Hosting bootstrap](/install/vps#3-install-fased-and-connect-through-tailscale)
    from the VPS provider's root console. Execute the downloaded standalone
    installer with `--hosting` only after its release attestation succeeds.
  </Tab>
  <Tab title="Repair hosting">
    Follow the same
    [pre-execution verified release-asset procedure](/install/vps#3-install-fased-and-connect-through-tailscale),
    but use `--repair-hosting` in the final invocation of the already-verified
    standalone installer. Never use raw `curl | bash` for this root repair.

    Refreshes an existing hosted runtime and root-managed Gateway service
    without rerunning onboarding or resetting persistent state.

  </Tab>
  <Tab title="Local profile">
    ```bash
    ./install.sh --local
    ```
  </Tab>
  <Tab title="Repair Local or WSL">
    ```bash
    ./install.sh --repair-local
    ```

    Repairs the managed Local/WSL runtime and user Gateway service without
    rerunning onboarding or resetting persistent state.

  </Tab>
  <Tab title="Verbose">
    ```bash
    ./install.sh --verbose
    ```
  </Tab>
</Tabs>

## Common public flags

These are the flags that matter for the current public repo-backed flow.

| Flag                         | Description                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `--auto-install`             | Install missing macOS/Linux dependencies where supported.                       |
| `--no-auto-install`          | Do not install missing dependencies automatically.                              |
| `--install-dir <path>`       | Bootstrap or resolve the checkout under a specific directory.                   |
| `--hosting`                  | Use hosted/VPS onboarding defaults; root bootstrap also requires `--release`.   |
| `--repair-hosting`           | Repair hosted runtime/service state from the tagged provider-console bootstrap. |
| `--release <vX.Y.Z\|latest>` | Select and attest the exact Hosting release before privileged setup.            |
| `--repair-local`             | Repair Local/WSL runtime and user service without onboarding.                   |
| `--local`                    | Use local-machine onboarding defaults.                                          |
| `--source-install`           | Build Local from source; refused for privileged VPS Hosting.                    |
| `--swap-gb <n>`              | Override automatic install-time swap sizing on small Linux hosts.               |
| `--no-onboard`               | Build/install and skip onboarding.                                              |
| `--verbose`                  | Show install command output instead of only log paths.                          |
| `--help`                     | Show usage (`-h`).                                                              |

Extra arguments after `--` are forwarded to `fased onboard --install-daemon`.

<Note>
The script may still contain additional internal or legacy flags. For the exact
current surface, run `./install.sh --help` from the repo root.
</Note>

## Environment variables

- `FASED_INSTALL_REPO=<url>`: repo URL used by bootstrap installs.
- `FASED_INSTALL_DIR=<path>`: checkout/install directory.
- `FASED_STATE_DIR=<path>`: runtime state directory for config, sessions,
  credentials, logs, wallets, and caches.
- `FASED_CONFIG_PATH=<path>`: explicit config file path. Defaults to
  `$FASED_STATE_DIR/fased.json`.
- `FASED_CONFIG_DIR=<path>`: installer compatibility alias for state, install
  marker, cache, and logs directory. Prefer `FASED_STATE_DIR` for new installs.
- `FASED_CLI_BIN_DIR=<path>`: directory where `install.sh` writes the `fased`
  command.
- `FASED_INSTALL_VERBOSE=1`: show install command output instead of only log
  paths.
- `FASED_INSTALL_USER=<name>`: non-root app user used by root bootstrap installs.
- `FASED_RUNTIME_NPM_PACKAGE=<spec>`: advanced release-runtime package override.
- `FASED_HOSTING_NPM_PACKAGE=<spec>`: compatibility alias for hosted installs.
- `FASED_SOURCE_INSTALL=1`: build from the checkout instead of using a verified
  Linux release runtime.
- `FASED_HOSTING_SOURCE_INSTALL=1`: retired for maintained Hosting. Privileged
  Hosting refuses source/app checkouts and requires a tagged attested bundle.
- `FASED_EXISTING_DATA_ACTION=<mode>`: advanced local state override: `keep`,
  `reset-config`, or `separate-state`. Normal installs keep existing state
  automatically.
- `FASED_EXISTING_DATA_DIR=<path>`: state directory used with
  `FASED_EXISTING_DATA_ACTION=separate-state`.
- `FASED_SAT_RUNTIME_ENV_FILE=<path>`: optional SAT runtime ID env file for
  explicit test networks or verified manual recovery. Normal mainnet setup uses
  Mining Sync.

## Automation

Local headless install without onboarding:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --no-onboard
```

This raw bootstrap is Local only. If you automate a hosted install, begin with
the attested standalone release asset in the
[verified Hosting procedure](/install/vps#3-install-fased-and-connect-through-tailscale)
and keep the same security order:

1. provision the host
2. let the hosted installer start Tailscale and approve the printed login URL;
   use an auth key only for non-interactive provisioning
3. run onboarding
4. access Control UI / gateway only through Tailscale or a deliberate private
   tunnel

Use a controlled Local install directory in CI or on a self-managed host:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --install-dir "$HOME/agent" --no-onboard
```

## Package runtime note

The raw curl bootstrap is the public Local first-run path because it can install
missing OS tools, Git, and Node. VPS Hosting instead downloads and verifies the
standalone tagged installer before any privileged execution. Supported Linux
Local and VPS Hosting installs use the verified release runtime when available.
The source checkout remains the Local setup/repair anchor; privileged Hosting
repair starts from a new verified release asset. Users should still begin with
the appropriate Fased installer path so service setup, host security, and
onboarding stay aligned.

Bun global installs are not the public Fased install path; Bun remains
experimental local development only.

## Related

- [Install](/install)
- [Updating](/install/updating)
- [Docker](/install/docker)
- [Onboarding Wizard](/cli/onboard)
