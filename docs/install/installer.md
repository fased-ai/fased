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

If you are starting from zero, the normal path is:

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh
```

<Note>
On Windows, use [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install), then run the same repo-backed commands inside Ubuntu.
</Note>

## What `install.sh` does

<Steps>
  <Step title="Detect the host environment">
    Supports macOS, Linux, and WSL2.
  </Step>
  <Step title="Ensure a compatible Node.js runtime">
    Fased recommends Node 24 and requires Node 22.14 or newer with the built-in
    `node:sqlite` module. On supported Linux hosts, the installer can install
    missing dependencies when auto-install is enabled.
  </Step>
  <Step title="Ensure Git">
    Installs Git if it is missing.
  </Step>
  <Step title="Prepare the repo-backed runtime">
    Uses the checkout and install flow this repository actually supports for public use.
    Current installers attempt a fast-forward-only update from `origin` before
    dependency install and build. If source changes during that update, the
    installer restarts once so the new installer code runs.

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
    On low-memory Linux hosts, onboarding runs with a larger V8 heap limit after
    the installer has created swap when possible. Override with
    `FASED_ONBOARD_MAX_OLD_SPACE_MB` only for troubleshooting.

    For a hosted or VPS runtime, the intended sequence is:

    1. create or sign into your **Tailscale** account
    2. join the host to your tailnet
    3. run onboarding with the **hosting** profile
    4. open the printed Tailscale dashboard URL in your local browser
    5. save the gateway token in case the browser asks for it
    6. reconnect as the non-root `app` user over the Tailscale network for CLI work
    7. keep admin access private through Tailscale instead of opening the gateway directly

    Root is the bootstrap/emergency shell. After hosted onboarding completes,
    normal commands run as `app`; the shell starts in `/home/app/fased`:

    ```bash
    ssh app@YOUR_VPS_TAILSCALE_NAME
    fased status
    fased dashboard
    ```

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

Fresh machine, one copy-paste block:

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh
```

Hosting note:

- do Tailscale setup **before** onboarding
- when Tailscale prints a login URL in SSH, open it in your local browser
- use an auth key only for unattended automation
- use the **hosting** profile in the wizard
- keep access tailnet-only unless you later make a deliberate, separately-audited exposure choice

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

| Flag                   | Description                                                    |
| ---------------------- | -------------------------------------------------------------- |
| `--auto-install`       | Install missing Linux dependencies with `apt` where supported. |
| `--no-auto-install`    | Do not install missing dependencies automatically.             |
| `--install-dir <path>` | Bootstrap or resolve the checkout under a specific directory.  |
| `--hosting`            | Use hosted/VPS onboarding defaults.                            |
| `--local`              | Use local-machine onboarding defaults.                         |
| `--swap-gb <n>`        | Configure install-time swap on very small Linux hosts.         |
| `--no-onboard`         | Build/install and skip onboarding.                             |
| `--verbose`            | Show install command output instead of only log paths.         |
| `--help`               | Show usage (`-h`).                                             |

Extra arguments after `--` are forwarded to `fased onboard --install-daemon`.

<Note>
The script may still contain additional internal or legacy flags. For the exact
current surface, run `./install.sh --help` from the repo root.
</Note>

## Environment variables

| Variable                            | Description                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `FASED_INSTALL_REPO=<url>`          | Repo URL used by bootstrap installs.                                                                                            |
| `FASED_INSTALL_DIR=<path>`          | Checkout/install directory.                                                                                                     |
| `FASED_CONFIG_DIR=<path>`           | Config, install marker, cache, and logs directory.                                                                              |
| `FASED_CLI_BIN_DIR=<path>`          | Directory where `install.sh` writes the `fased` command.                                                                        |
| `FASED_INSTALL_VERBOSE=1`           | Show install command output instead of only log paths.                                                                          |
| `FASED_INSTALL_USER=<name>`         | Non-root app user used by root bootstrap installs.                                                                              |
| `FASED_SAT_RUNTIME_ENV_FILE=<path>` | Optional SAT runtime ID env file for explicit test networks or verified manual recovery. Normal mainnet setup uses Mining Sync. |

## Automation

Headless repo-backed install:

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh --no-onboard
```

If you automate a hosted install, keep the same security order:

1. provision the host
2. join it to Tailscale; use an auth key only for non-interactive provisioning
3. run onboarding
4. access Control UI / gateway only through Tailscale or a deliberate private tunnel

Use a controlled install directory in CI or on a managed host:

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh --install-dir "$HOME/agent" --no-onboard
```

## Not public install paths yet

Direct `npm install -g`, `pnpm add -g`, or Bun global package installs are not
the current public setup path. They can come back after package publication and
release automation are ready. Until then, the supported public path is the
repo-backed installer.

## Related

- [Install](/install)
- [Updating](/install/updating)
- [Docker](/install/docker)
- [Onboarding Wizard](/cli/onboard)
