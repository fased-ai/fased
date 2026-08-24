---
summary: "Run managed Fased Local inside Ubuntu WSL2, or access a remote Linux VPS from Windows."
read_when:
  - Installing Fased on Windows
  - Accessing a Fased VPS from Windows
title: "Windows (WSL2)"
---

# Windows

The managed Local matrix includes **Ubuntu WSL2 x86_64 with systemd**. Fased
does not run directly in native Windows, PowerShell, Command Prompt, Git Bash,
or native Windows Node.js.
There are two distinct uses:

- **Fased Local on this PC:** PowerShell provisions Ubuntu WSL2; installation,
  onboarding, and every `fased` command run inside the Ubuntu shell.
- **Fased runs on a VPS:** use native Windows Tailscale and SSH; Fased runs on
  the remote Linux VPS, not in Windows or WSL.

Ubuntu WSL2 reuses the verified Linux x86_64 release. The installer accepts
only WSL2—not WSL1—requires Ubuntu and systemd, permits only the Local profile,
and requires the operator home under Linux `/home` rather than `/mnt/c`.

<Tabs>
  <Tab title="Local Fased in WSL2">
    Fased Local requires Windows 11 or Windows 10 version 2004/build 19041 or
    newer. The wallet signer uses Unix sockets, so native Windows Node.js,
    PowerShell, Command Prompt, Git Bash, and WSL1 are not supported runtimes.

    ### 1. Administrator PowerShell

    Open PowerShell with **Run as administrator** and run only these Windows
    setup commands:

    ```powershell
    wsl --install -d Ubuntu
    wsl --update
    wsl --version
    wsl --list --verbose
    ```

    Restart Windows if requested. The Ubuntu row must show `VERSION 2`.

    ### 2. Ubuntu WSL2 shell

    Open **Ubuntu** from the Start menu and create its Linux username/password
    if prompted. Check systemd inside Ubuntu:

    ```bash
    ps -p 1 -o comm=
    ```

    It must print `systemd`. If it does not, create `/etc/wsl.conf` inside
    Ubuntu:

    ```bash
    printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf
    exit
    ```

    Back in PowerShell, stop WSL cleanly:

    ```powershell
    wsl --shutdown
    ```

    Reopen Ubuntu, confirm `ps -p 1 -o comm=` prints `systemd`, then run the
    managed Local installer inside Ubuntu:

    ```bash
    curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh \
      | bash -s -- --local
    ```

    Keep Fased state in the default Ubuntu home under `/home`. Do not move
    `~/.fased` onto `/mnt/c` or another Windows-mounted filesystem.

    ```bash
    fased status
    fased update
    ```

    `fased update` must finish with `Already current`. Open
    `http://localhost:18789` in the normal Windows browser; WSL localhost
    forwarding reaches the Gateway running inside Ubuntu.

    For first-machine acceptance, exit Ubuntu, run `wsl --shutdown` in
    PowerShell, reopen Ubuntu, and run `fased status` again. Gateway, signer,
    Wallet, task-ledger, and configuration state must remain available without
    reinstalling.

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
       [exact fresh Hosting command](/install/vps#3-install-fased)
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
    Source-development Wallet behavior is not a supported managed WSL2 custody
    boundary. Do not use it for reserve funds.

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
    Update a supported Linux VPS runtime.
  </Card>
  <Card title="Microsoft WSL guide" href="https://learn.microsoft.com/windows/wsl/install" icon="windows">
    Official Windows setup documentation.
  </Card>
</CardGroup>
