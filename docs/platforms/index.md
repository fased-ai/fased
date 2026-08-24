---
summary: "Platform support overview (Gateway + companion apps)"
read_when:
  - Looking for OS support or install paths
  - Deciding where to run the Gateway
title: "Platforms"
---

# Platforms

Fased core runs through the Gateway. Managed releases bundle an exact Node
runtime; users do not install Node globally.

The normal setup path is:

```mermaid
flowchart TD
  host["Gateway host"] --> ui["Browser Control UI"]
  host --> agents["Agents"]
  agents --> channels["Channels"]
  agents --> tools["Tools"]
  mac["macOS app"] --> host
  mobile["iOS / Android nodes"] --> host
  always["Pi / VPS hosts"] --> host

  classDef gatewayHost fill:#10151f,stroke:#38bdf8,color:#e0f2fe;
  classDef ui fill:#15110a,stroke:#f59e0b,color:#fff7ed;
  classDef node fill:#102016,stroke:#22c55e,color:#ecfdf5;
  class host gatewayHost;
  class ui,agents,channels,tools ui;
  class mac,mobile,always node;
```

The managed matrix is Linux x86_64 or arm64 with systemd for protected Local,
Ubuntu WSL2 x86_64 Local, native macOS x86_64 or arm64 Local with launchd, and
x86_64 Ubuntu-compatible or Rocky-compatible Hosting. Native Windows remains
deferred.

Ubuntu inside WSL2 reuses the Linux x86_64 release but has a stricter preflight:
WSL2 rather than WSL1, the Ubuntu distribution, systemd as PID 1, Local profile
only, and operator state under the WSL Linux `/home` filesystem. The installer
fails before acquisition when those predicates are absent. macOS selects
separate signed Darwin assets and system LaunchDaemons; it never aliases a
Linux artifact with the same CPU architecture.

## Current UI model

- The Gateway serves the browser Control UI at `http://localhost:18789`.
- Normal setup is Agent-first: open **Agents**, select an Agent, then use its
  **Models**, **Channels**, **Skills**, **Tools**, **Memory**, **Services**, and
  **Tasks** tabs.
- **Dashboard** is the customizable overview board.
- **Chat** is the normal browser chat surface for the selected Agent/session.
- **Advanced** contains raw Config, Debug, and Nodes operator surfaces. Mobile
  and desktop companion devices appear under **Advanced → Nodes**.

## Choose your OS

- [macOS](/platforms/macos): native managed Local on Apple Silicon and Intel,
  plus the optional companion app.
- [Linux](/platforms/linux): Gateway host, local machine, VPS, or always-on node.
- [Windows](/platforms/windows): run managed Local inside Ubuntu WSL2, or manage
  a supported remote Linux VPS. Native Windows remains deferred.
- [iOS](/platforms/ios): mobile node connected to another Gateway.
- [Android](/platforms/android): mobile node connected to another Gateway.
- [Raspberry Pi](/platforms/raspberry-pi): low-power always-on Gateway host.

## VPS & hosting

- VPS hub: [VPS hosting](/install/vps)
- Raspberry Pi: [Raspberry Pi](/platforms/raspberry-pi)
- Hetzner: [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- DigitalOcean: [DigitalOcean](/platforms/digitalocean)
- Oracle Cloud: [Oracle](/platforms/oracle)

All VPS provider guides use the non-Docker `install.sh --hosting` profile. The
full Docker Gateway is Local only. Fly.io and Render are
[unsupported archives](/install/fly), not hosting options.

## Common links

- Install guide: [Getting Started](/start/getting-started)
- Gateway runbook: [Gateway](/gateway)
- Gateway configuration: [Configuration](/gateway/configuration)
- Service status: `fased gateway status`

## Gateway service install (CLI)

These commands are for contributor/source runtimes only:

- Wizard (recommended): `fased onboard --install-daemon`
- Direct: `fased gateway install`
- Configure flow: `fased configure` → select **Gateway service**
- Repair/migrate: `fased doctor` (offers to install or fix the service)

They are not alternatives to the Go lifecycle in a managed installation. The
source-runtime service target depends on OS:

- macOS: LaunchAgent (`ai.fased.gateway` or `ai.fased.<profile>`; legacy
  `com.fased.*`)
- Linux/WSL2: systemd user service (`fased-gateway[-<profile>].service`)
