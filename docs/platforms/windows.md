---
summary: "Run Fased locally in WSL2 Ubuntu, or manage a remote VPS from Windows."
read_when:
  - Installing Fased on Windows
  - Accessing a Fased VPS from Windows
title: "Windows (WSL2)"
---

# Windows

There are two different Windows workflows:

- **Fased runs on this Windows PC:** install and run it inside WSL2 Ubuntu.
- **Fased runs on a VPS:** use native Windows Tailscale and SSH; Fased runs on
  the remote Linux VPS, not in Windows or WSL.

<Tabs>
  <Tab title="Local Fased in WSL2">
    Fased Local requires Windows 11 or Windows 10 version 2004/build 19041 or
    newer. The wallet signer uses Unix sockets, so native Windows Node.js,
    PowerShell, Command Prompt, Git Bash, and WSL1 are not supported runtimes.
    The published npm package intentionally rejects native Windows with
    `EBADPLATFORM`; do not override npm's platform check. WSL2 reports Linux and
    receives the supported Linux package and signer asset.

    ### 1. Administrator PowerShell

    Open PowerShell with **Run as administrator** and run only these Windows
    setup commands:

    ```powershell
    wsl --install -d Ubuntu
    wsl --update
    wsl --version
    wsl --list --verbose
    ```

    Restart Windows if requested. WSL must be `0.67.6` or newer and the Ubuntu
    row must show `VERSION 2`.

    ### 2. Ubuntu WSL2 shell

    Open **Ubuntu** from the Start menu and create its Linux username/password
    if prompted. Then run this separate block inside Ubuntu:

    ```bash
    uname -s
    ps -p 1 -o comm=
    curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \
      | bash -s -- --local
    ```

    `uname -s` must print `Linux`; PID 1 must be `systemd`. Keep every later
    `fased` command in Ubuntu:

    ```bash
    fased health
    fased dashboard
    ```

    The dashboard opens in the normal Windows browser through WSL localhost
    forwarding.

  </Tab>

  <Tab title="Access a VPS from Windows">
    WSL2 is not required when Fased runs on a remote VPS.

    1. Install the native [Tailscale Windows app](https://tailscale.com/download)
       and sign in.
    2. In PowerShell or Windows Terminal, connect to the VPS:

       ```powershell
       ssh root@YOUR_PUBLIC_VPS_IP
       ```

    3. After the prompt changes to the remote Linux VPS, run:

       Follow the
       [verified Hosting bootstrap](/install/vps#3-verify-and-run-the-hosting-bootstrap)
       in that VPS SSH session.

    The Bash command runs on the VPS through SSH. The installer installs or
    starts Tailscale on the VPS and prints the login URL to open in Windows.
    After setup, reconnect privately:

    ```powershell
    ssh app@YOUR_VPS_TAILSCALE_NAME
    ```

    Continue with [VPS Hosting](/install/vps).

  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="If Ubuntu is WSL1">
    In Administrator PowerShell, copy the exact distribution name shown by
    `wsl --list --verbose`, then convert it:

    ```powershell
    wsl --set-version "<EXACT DISTRO NAME>" 2
    ```

  </Accordion>

  <Accordion title="If systemd is not running">
    Inside Ubuntu, create or edit `/etc/wsl.conf`:

    ```ini
    [boot]
    systemd=true
    ```

    Close Ubuntu, run `wsl --shutdown` once in PowerShell, reopen Ubuntu, and
    check `ps -p 1 -o comm=` again. See Microsoft's
    [WSL systemd guide](https://learn.microsoft.com/windows/wsl/systemd).

  </Accordion>

  <Accordion title="Wallet signer behavior on WSL2">
    First-wallet setup downloads the version-matched Linux signer, verifies its
    checksum and release attestation, and installs it automatically. Users do
    not install Go.

    Local WSL2 runs Gateway and signer under the same Linux account. Keep Local
    wallet balances limited. VPS Hosting uses an independent signer account;
    hardware-backed Wallet Standard or a reviewed custody provider offers a
    stronger boundary for reserve funds.

  </Accordion>

  <Accordion title="Signer security-key enrollment">
    Run the enrollment launcher inside Ubuntu:

    ```bash
    "$HOME/.fased/bin/fased-signer-enroll" "Primary security key"
    ```

    Open its short-lived `http://localhost:18791/...` URL in the Windows
    browser. Do not create a Windows `portproxy`, LAN bind, firewall exposure,
    or public tunnel for the enrollment port.

  </Accordion>
</AccordionGroup>

<CardGroup cols={2}>
  <Card title="Install" href="/install" icon="download">
    Local and VPS quick commands.
  </Card>
  <Card title="VPS Hosting" href="/install/vps" icon="server">
    Private access and recovery.
  </Card>
  <Card title="Updating" href="/install/updating" icon="refresh-cw">
    Update Local WSL2 or a VPS runtime.
  </Card>
  <Card title="Microsoft WSL guide" href="https://learn.microsoft.com/windows/wsl/install" icon="windows">
    Official Windows setup documentation.
  </Card>
</CardGroup>
