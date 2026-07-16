---
summary: "Windows (WSL2) support + companion app status"
read_when:
  - Installing Fased on Windows
  - Looking for Windows companion app status
title: "Windows (WSL2)"
---

# Windows (WSL2)

Fased on Windows runs **inside WSL2 Ubuntu**. The CLI, Gateway, wallet signer,
updates, and service all run inside Linux. Native Windows PowerShell, Command
Prompt, Git Bash, and native Windows Node.js are not supported Fased runtime
shells. Wallet signing specifically requires Unix sockets.

Native Windows companion apps are planned.

<Warning>
Use Administrator PowerShell only for the `wsl` management commands in steps 1
and 2. After Ubuntu opens, switch to the Ubuntu shell and run every Fased
command there. A prompt beginning with `PS C:\` is PowerShell and is the wrong
place to run `install.sh`.
</Warning>

## Supported Windows versions

The one-command WSL installation requires one of:

- Windows 11
- Windows 10 version 2004 or newer, build 19041 or newer

Press `Windows + R`, run `winver`, and check the version and build. Older
Windows releases must follow Microsoft's manual WSL installation instructions
or update Windows before installing Fased.

## Install WSL2 Ubuntu and Fased

### 1. Install WSL2 and Ubuntu in Administrator PowerShell

Open PowerShell with **Run as administrator** and run:

```powershell
wsl --install -d Ubuntu
```

Restart Windows if requested. If WSL is already installed but Ubuntu is not,
list the available distributions and install Ubuntu explicitly:

```powershell
wsl --list --online
wsl --install -d Ubuntu
```

### 2. Confirm that Ubuntu uses WSL2

In PowerShell:

```powershell
wsl --list --verbose
```

The `Ubuntu` row must show `VERSION 2`. If it shows version 1, convert it:

```powershell
wsl --set-version Ubuntu 2
```

### 3. Open the Ubuntu application

Open **Ubuntu** from the Windows Start menu. The first launch asks you to create
a Linux username and password. This account is separate from the Windows
account.

Confirm that the shell is Linux:

```bash
uname -s
```

The result must be `Linux`. Run `pwd` if needed; a normal home directory looks
like `/home/YOUR_LINUX_USER`, not `C:\...` or `/mnt/c/Windows/System32`.

Current Ubuntu distributions installed by `wsl --install` use systemd by
default. Verify it before installing the Gateway service:

```bash
ps -p 1 -o comm=
```

The result must be `systemd`. If it is not, create or edit `/etc/wsl.conf`
inside Ubuntu:

```ini
[boot]
systemd=true
```

Then close Ubuntu, run this once in PowerShell, and reopen Ubuntu:

```powershell
wsl --shutdown
```

Verify `ps -p 1 -o comm=` again before continuing. The installer stops before
creating wallet state on WSL1 or WSL2 without systemd.

### 4. Install Fased inside the Ubuntu shell

Run this in Ubuntu, not PowerShell:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \
  | bash -s -- --local
```

The installer prepares the Linux runtime and starts Local onboarding. Keep all
later Fased commands inside Ubuntu:

```bash
fased --version
fased doctor
fased dashboard
```

When the first wallet is created, Fased downloads the Linux signer asset
matching the installed Fased version, verifies its SHA-256 checksum and GitHub
release attestation, and installs it automatically. Normal users do not install
Go. Existing-key import is an explicit signer-admin operation so the Gateway
process never receives the private key.

### 5. Open the dashboard from Windows

The Gateway remains inside WSL2, but the dashboard URL can be opened in the
normal Windows browser. Keep the Ubuntu shell and WSL2 Gateway available while
using Fased.

Related documentation:

- [Getting Started](/start/getting-started)
- [Install & updates](/install/updating)
- [Installer reference](/install/installer)
- Official WSL installation guide (Microsoft):
  [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

## Gateway service install (CLI)

Inside WSL2:

```
fased onboard --install-daemon
```

Or:

```
fased gateway install
```

Or:

```
fased configure
```

Select **Gateway service** when prompted.

Repair/migrate:

```
fased doctor
```

## Advanced: expose WSL services over LAN (portproxy)

WSL has its own virtual network. If another machine needs to reach a service
running **inside WSL** (SSH, a local TTS server, or the Gateway), expose it
deliberately through Windows port forwarding. The WSL IP changes after restarts,
so you may need to refresh the forwarding rule.

Example (PowerShell **as Administrator**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Allow the port through Windows Firewall (one-time):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Refresh the portproxy after WSL restarts:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Notes:

- SSH from another machine targets the **Windows host IP** (example: `ssh user@windows-host -p 2222`).
- Remote nodes must point at a **reachable** Gateway URL (not `127.0.0.1`); use
  `fased status --all` to confirm.
- Use `listenaddress=0.0.0.0` only for intended LAN access; `127.0.0.1` keeps it
  local only. If the Gateway is reachable from other devices, require
  token/password auth.
- If you want this automatic, register a Scheduled Task to run the refresh
  step at login.

## Windows companion app

We do not have a Windows companion app yet. Contributions are welcome if you want to help build one.
