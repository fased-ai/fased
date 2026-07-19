---
summary: "Install Fased locally or on an always-on VPS."
read_when:
  - You want to install Fased
  - You need to choose between Local and VPS Hosting
title: "Install"
---

# Install

Choose where Fased will run. **Local** runs on your computer. **VPS Hosting**
runs continuously on a remote Linux server.

<Tabs>
  <Tab title="Local">
    Run this in macOS Terminal, a Linux terminal, or an Ubuntu WSL2 shell:

    ```bash
    curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --local
    ```

    On Windows, install Fased **inside WSL2 Ubuntu**. Do not run the Bash
    command in PowerShell, Command Prompt, Git Bash, or native Windows Node.js.
    Follow [Windows Local setup](/platforms/windows).

    Local setup does not apply VPS firewall or SSH changes. Tailscale is
    optional.

  </Tab>

  <Tab title="VPS Hosting">
    Use a fresh Ubuntu LTS VPS for the simplest supported path.

    1. Install and sign into [Tailscale](https://tailscale.com/download) on
       your own computer.
    2. SSH into the VPS using the login supplied by your provider:

       ```bash
       ssh root@YOUR_PUBLIC_VPS_IP
       ```

    3. In that VPS SSH session, follow the
       [verified Hosting bootstrap](/install/vps#3-verify-and-run-the-hosting-bootstrap).

    The procedure verifies the exact tagged bootstrap before it runs. The
    installer then verifies the tagged Hosting
    release artifacts and attestations, installs or starts Tailscale on the
    VPS, creates the non-root `app` runtime, and guides private dashboard/SSH
    access. Open the Tailscale login URL it prints on your own computer.

    Continue with the [three-step VPS guide](/install/vps) for access checks,
    advanced verification, and troubleshooting.

  </Tab>
</Tabs>

<Note>
The VPS command runs **inside the VPS**, not in a local PowerShell window.
Windows users can manage a VPS with native Windows Tailscale and SSH; WSL2 is
required only when Fased itself runs locally on Windows.
</Note>

## After installation

The wizard opens or prints the Control UI address. Then:

1. Connect a model under **Agent > Models**.
2. Send a test message in **Chat**.
3. Add channels, services, wallets, or mining only when needed.

If setup was interrupted:

```bash
fased onboard --install-daemon
fased health
fased dashboard
```

## Updating

```bash
fased update status
fased update
```

On VPS Hosting, run updates after reconnecting as `app` through Tailscale.

<AccordionGroup>
  <Accordion title="What the first curl command trusts">
    The first script is downloaded from the protected `fased-ai/fased` GitHub
    repository over HTTPS. After it starts, it resolves one stable tag and
    verifies the release manifest and architecture-specific bundle with GitHub
    attestations before privileged Fased installation.

    Users who need to verify `install.sh` **before any shell code runs** can use
    the manual release-asset procedure in
    [Advanced: verify the bootstrap first](/install/vps#advanced-verify-the-bootstrap-first).
    That is an additional bootstrap check, not a different Hosting product.

  </Accordion>

  <Accordion title="Supported systems">
    - Local: macOS, WSL2 Ubuntu, and common Linux distributions.
    - VPS Hosting hardening: Ubuntu, Fedora, and RHEL-family Linux with systemd.
    - Docker: Local only. There is no `--hosting-docker` mode.
    - Native Windows: not supported; use WSL2 Ubuntu for Local.
  </Accordion>

  <Accordion title="Security and recovery boundary">
    VPS Hosting keeps the Gateway private through Tailscale and runs the app as
    the non-root `app` user. Keep both your Tailscale account recovery and VPS
    provider console access working. Do not expose the raw Gateway port to the
    public internet.
  </Accordion>
</AccordionGroup>

## More install guides

<CardGroup cols={2}>
  <Card title="VPS Hosting" href="/install/vps" icon="server">
    Full access checks, advanced verification, and recovery.
  </Card>
  <Card title="Windows (WSL2)" href="/platforms/windows" icon="windows">
    Separate PowerShell and Ubuntu WSL2 steps.
  </Card>
  <Card title="Installer reference" href="/install/installer" icon="terminal">
    Flags, automation, and installer behavior.
  </Card>
  <Card title="Docker Local" href="/install/docker" icon="container">
    Containerized Local Gateway; not VPS Hosting.
  </Card>
  <Card title="Updating" href="/install/updating" icon="refresh-cw">
    Stable updates and repair procedures.
  </Card>
  <Card title="Uninstall" href="/install/uninstall" icon="trash-2">
    Remove services, CLI, and state.
  </Card>
</CardGroup>
