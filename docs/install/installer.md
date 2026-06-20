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

If you are starting from zero on your own computer, use the Local install:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash
```

If you are starting from zero on a VPS, use the Hosting install from
[Install](/install). Ubuntu LTS is the recommended first VPS target.

<Note>
On Windows, use [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install),
then run the same bootstrap command inside Ubuntu.
</Note>

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
    4. when prompted, test `ssh app@YOUR_VPS_TAILSCALE_NAME` from your own computer
    5. confirm only after SSH reaches `/home/app/fased`
    6. open the printed Tailscale dashboard URL in your local browser
    7. save the gateway token in case the browser asks for it
    8. reconnect as the non-root `app` user over the Tailscale network for CLI work
    9. keep admin access private through Tailscale instead of opening the gateway directly

    Root is the bootstrap/emergency shell. After hosted onboarding completes,
    normal commands run as `app`; the shell starts in `/home/app/fased`:

    ```bash
    ssh app@YOUR_VPS_TAILSCALE_NAME
    cd /home/app/fased
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

| System family                                            | Package manager path                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| Ubuntu, Debian, Kali, WSL2 Ubuntu                        | `apt-get` + NodeSource Node 24 when needed                        |
| Fedora                                                   | `dnf` / `dnf5`; native Node 24 package first, NodeSource fallback |
| CentOS, AlmaLinux, Rocky Linux, CloudLinux, Oracle Linux | `dnf` / `yum` + NodeSource Node 24 fallback                       |
| Amazon Linux                                             | `dnf` / `yum` + NodeSource Node 24 fallback                       |
| openSUSE, SLES                                           | `zypper` packages, then runtime verification                      |
| Alpine                                                   | `apk` packages, then runtime verification                         |
| Arch                                                     | `pacman` packages, then runtime verification                      |
| FreeBSD                                                  | `pkg` packages, then runtime verification                         |
| macOS                                                    | Homebrew, if Homebrew is already installed                        |

If a provider image ships an old or custom Node build, the installer stops with
the exact Node problem instead of continuing with a broken runtime.

Fresh machine, one copy-paste block:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash
```

Fresh VPS hosting uses the OS-specific steps in [Install](/install#vps-hosting-install).
The Fased hosted installer installs/starts Tailscale when needed and runs the
browser login with timeout/readiness checks.

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --hosting
```

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

- fresh dashboard, Gateway, and Fased Network setup do not require `fased-signerd`
- generated signer binaries are not committed to Git
- when you later choose the local signer wallet path, Fased builds
  `fased-signerd` locally when Go is available
- otherwise provide `FASED_WALLET_LOCAL_SIGNER_BIN`, or an explicit signer asset
  source with `FASED_LOCAL_SIGNER_VERSION` / `FASED_LOCAL_SIGNER_BASE_URL`

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
    ```bash
    ./install.sh --hosting
    ```
  </Tab>
  <Tab title="Local profile">
    ```bash
    ./install.sh --local
    ```
  </Tab>
  <Tab title="Verbose">
    ```bash
    ./install.sh --verbose
    ```
  </Tab>
</Tabs>

## Common public flags

These are the flags that matter for the current public repo-backed flow.

| Flag                   | Description                                                       |
| ---------------------- | ----------------------------------------------------------------- |
| `--auto-install`       | Install missing macOS/Linux dependencies where supported.         |
| `--no-auto-install`    | Do not install missing dependencies automatically.                |
| `--install-dir <path>` | Bootstrap or resolve the checkout under a specific directory.     |
| `--hosting`            | Use hosted/VPS onboarding defaults.                               |
| `--local`              | Use local-machine onboarding defaults.                            |
| `--swap-gb <n>`        | Override automatic install-time swap sizing on small Linux hosts. |
| `--no-onboard`         | Build/install and skip onboarding.                                |
| `--verbose`            | Show install command output instead of only log paths.            |
| `--help`               | Show usage (`-h`).                                                |

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
- `FASED_HOSTING_NPM_PACKAGE=<spec>`: advanced hosted runtime package override.
- `FASED_HOSTING_SOURCE_INSTALL=1`: advanced hosted testing path that uses the
  source checkout, `pnpm`, and local builds instead of the prebuilt runtime.
- `FASED_EXISTING_DATA_ACTION=<mode>`: advanced local state override: `keep`,
  `reset-config`, or `separate-state`. Normal installs keep existing state
  automatically.
- `FASED_EXISTING_DATA_DIR=<path>`: state directory used with
  `FASED_EXISTING_DATA_ACTION=separate-state`.
- `FASED_SAT_RUNTIME_ENV_FILE=<path>`: optional SAT runtime ID env file for
  explicit test networks or verified manual recovery. Normal mainnet setup uses
  Mining Sync.

## Automation

Headless install without onboarding:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --no-onboard
```

If you automate a hosted install, keep the same security order:

1. provision the host
2. let the hosted installer start Tailscale and approve the printed login URL;
   use an auth key only for non-interactive provisioning
3. run onboarding
4. access Control UI / gateway only through Tailscale or a deliberate private
   tunnel

Use a controlled install directory in CI or on a managed host:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --install-dir "$HOME/agent" --no-onboard
```

## Package runtime note

The curl bootstrap is the public first-run path for fresh machines because it
can install missing OS tools, Git, and Node, then choose the right Local or VPS
Hosting setup. Hosted installs may use the published npm package internally as
the runtime payload, but users should still begin with the Fased installer so
Tailscale, service setup, host hardening, and onboarding stay aligned.

Bun global installs are not the public Fased install path; Bun remains
experimental local development only.

## Related

- [Install](/install)
- [Updating](/install/updating)
- [Docker](/install/docker)
- [Onboarding Wizard](/cli/onboard)
