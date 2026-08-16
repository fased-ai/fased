---
title: "Node.js"
summary: "Install and configure Node.js for Fased — version requirements, install options, and PATH troubleshooting"
read_when:
  - "You are developing Fased from source and need Node.js"
  - "You installed Fased but `fased` is command not found"
  - "The repo-backed launcher is not on PATH"
---

# Node.js

Managed Local and Hosting users do not install or maintain Node.js. The verified
installer supplies the exact runtime inside the signed generation. This page is
for source development, unmanaged package compatibility, or PATH diagnostics.
Those environments use Node 24, or Node 22.14 or newer with built-in
`node:sqlite`.

## Check your version

```bash
node -v
node -e 'require("node:sqlite"); console.log("node:sqlite ok")'
```

If this prints `v24.x` or `v22.14.x` or higher and `node:sqlite ok`, you are
set. If Node is missing, too old, or missing `node:sqlite`, pick an install
method below. Some custom/version-manager Node builds can report a new version
but still omit `node:sqlite`; those are not suitable for full memory support.

## Install Node

<Tabs>
  <Tab title="macOS">
    **Homebrew** (recommended for source development). The public managed
    installer does not support macOS in the first stable matrix.

    ```bash
    brew install node
    ```

    Or download the macOS installer from [nodejs.org](https://nodejs.org/).

  </Tab>
  <Tab title="Ubuntu">
    Use this for Ubuntu, Debian, or Kali:

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    If NodeSource does not yet support a brand-new Ubuntu/Debian codename,
    install the distro packages and keep the `node:sqlite` verification step:

    ```bash
    sudo apt-get update
    sudo apt-get install -y nodejs npm
    node -e 'require("node:sqlite"); console.log("node:sqlite ok")'
    ```

  </Tab>
  <Tab title="Fedora">
    ```bash
    sudo dnf install -y nodejs24-bin nodejs24-npm-bin
    ```
  </Tab>
  <Tab title="RHEL">
    Use this for CentOS, AlmaLinux, Rocky Linux, CloudLinux, Oracle Linux, or
    Amazon Linux:

    ```bash
    curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
    sudo dnf install -y nodejs
    ```

    Use `yum` instead of `dnf` on older images.

  </Tab>
  <Tab title="SUSE">
    Use this for openSUSE or SLES:

    ```bash
    sudo zypper --non-interactive install --no-recommends nodejs24 npm24
    ```

  </Tab>
  <Tab title="Alpine">
    ```bash
    sudo apk add --no-cache nodejs npm
    ```
  </Tab>
  <Tab title="Arch">
    ```bash
    sudo pacman -Sy --needed nodejs npm
    ```
  </Tab>
  <Tab title="FreeBSD">
    ```bash
    sudo pkg install -y node24 npm-node24
    ```
  </Tab>
  <Tab title="Windows / WSL2">
    Do not install Node with `winget`, Chocolatey, or a native Windows Node.js
    installer for a managed Fased runtime. WSL2 and native Windows are deferred
    from the first managed stable matrix. Maintainers may use WSL2 for source
    development with the Ubuntu instructions above; do not present that as a
    supported public managed install. Native Windows Node.js cannot run the
    Unix-socket wallet signer path. See [Windows](/platforms/windows).
  </Tab>
</Tabs>

If Node 24 packages are unavailable for your OS, use Node 22.14 or newer with
`node:sqlite`, install Node 24 from your preferred trusted package source, or
use a version manager.

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  Version managers let you switch between Node versions easily. Popular options:

- [**fnm**](https://github.com/Schniz/fnm) — fast, cross-platform
- [**nvm**](https://github.com/nvm-sh/nvm) — widely used on macOS/Linux
- [**mise**](https://mise.jdx.dev/) — polyglot (Node, Python, Ruby, etc.)

Example with fnm:

```bash
fnm install 22
fnm use 22
```

<Warning>
Make sure your version manager is initialized in your shell startup file
(`~/.zshrc` or `~/.bashrc`). If it is not, new terminal sessions may not find
`fased` because PATH does not include Node's bin directory.
</Warning>
</Accordion>

## Troubleshooting

### `fased: command not found`

Source installs write a small repo-backed launcher to
`${FASED_CLI_BIN_DIR:-$HOME/.local/bin}/fased`. Supported Linux Local and VPS
Hosting installs use the stable launcher created by the Go lifecycle host.
This error usually means the relevant bin directory is not on your PATH, or
your shell has not reloaded its startup files yet.

<Steps>
  <Step title="Check for the launcher">
    ```bash
    ls -l "$HOME/.local/bin/fased"
    ```
  </Step>
  <Step title="Check if it's on your PATH">
    ```bash
    echo "$PATH"
    ```

    Look for `$HOME/.local/bin` in the output. If you used
    `FASED_CLI_BIN_DIR`, look for that directory instead.

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        Add to `~/.zshrc` or `~/.bashrc`:

        ```bash
        export PATH="$HOME/.local/bin:$PATH"
        ```

        Then open a new terminal (or run `rehash` in zsh / `hash -r` in bash).
      </Tab>
      <Tab title="Windows / WSL2">
        Add the same line to the Ubuntu shell startup file inside WSL2 for a
        source-development checkout. WSL2 and native Windows are not in the
        first public managed matrix.
      </Tab>
    </Tabs>

  </Step>
</Steps>

### Advanced: npm global prefix problems

The public install path is the Fased curl installer and does not use npm.

If you are debugging a legacy manual package installation and see `EACCES`,
migrate to the verified managed installer. The following prefix setup is only
for an isolated maintainer compatibility test, never a managed install:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Add the `export PATH=...` line to your `~/.bashrc` or `~/.zshrc` to make it permanent.
