---
summary: "Fased is a user-run agent with a browser dashboard, channels, plugins, wallets, and optional Satcoin mining."
read_when:
  - Introducing Fased to newcomers
title: "Fased"
---

# Fased

**A user-run agent for tasks, channels, wallets, and mining.**

Start by choosing one of two setup profiles:

- **Local install** for a laptop, desktop, dev box, or WSL2.
- **VPS Hosting install** for an always-on server.

After the Gateway and browser dashboard are working, add channels, services,
wallet features, Fased Network, or Satcoin mining only where you need them.

Fased Agent gives you sessions, tools, memory, channels, plugins, and safety
controls in the selected setup profile.

**Gateway + agent + channels + optional wallet, network, and mining paths.**

<Columns>
  <Card title="Get Started" href="/start/getting-started" icon="rocket">
    Choose Local or VPS Hosting and bring up the Gateway.
  </Card>
  <Card title="Run the Wizard" href="/start/wizard" icon="sparkles">
    Guided setup with `fased onboard` and pairing flows.
  </Card>
  <Card title="Open the Control UI" href="/web/control-ui" icon="layout-dashboard">
    Launch the browser dashboard for chat, config, and sessions.
  </Card>
</Columns>

## What is Fased?

Fased is a **user-run agent**. You can use it immediately through the browser
dashboard, then add channels, services, plugins, wallet features, Fased Network,
and Satcoin mining as your setup grows.

**Who is it for?** Developers, operators, and power users who want an agent they
can message from the browser or chat apps, with local setup and clear safety
boundaries.

**What makes it different?**

- **User-run agent**: choose Local for this computer or VPS Hosting for an always-on server
- **Browser-first setup**: start in the Control UI before adding chat channels
- **Skills and plugins**: agents can run useful workflows across tools and services
- **Wallet features when enabled**: reviewed sends, receive links, receipts, and audit
- **Fased Network**: public handles, routing, service discovery, and reviewed offers
- **Optional Satcoin path**: mining can build public mining history
- **Clear add-on paths**: wallets, Fased Network, Satcoin mining, and Marketplace stay separate from first chat

The product shape is simple: start with the base agent, then add the advanced
paths only when they have a specific job.

- **Self-hosted**: runs on your own computer or your own VPS
- **Multi-channel**: one Gateway serves WhatsApp, Telegram, Discord, and more simultaneously
- **Agent-native**: built for coding agents with tool use, sessions, memory, and multi-agent routing
- **Wallet-ready when enabled**: wallet actions can use limits, approvals, and audit
- **Network-ready when enabled**: Fased Network and Satcoin mining live beside the base agent
- **Open source**: MIT licensed with preserved upstream and third-party notices

**What do you need?** For normal setup, use the installer path for Local or VPS
Hosting. If you manage Node yourself, use Node 24, or Node 22.14+ with
`node:sqlite`.

## How it works

```mermaid
flowchart TD
  entry["Channels / Control UI"] --> gateway["Gateway"]
  gateway --> agent["Fased Agent"]
  agent --> tools["Tools + skills"]
  agent --> wallets["Optional wallet use"]
  agent --> network["Optional Fased Network"]
  agent --> mining["Optional Satcoin mining"]

  classDef entry fill:#120605,stroke:#ff5a36,color:#ffffff;
  classDef core fill:#071018,stroke:#12cfff,color:#ffffff;
  classDef operator fill:#20120a,stroke:#ffb020,color:#ffffff;
  class entry entry;
  class gateway,agent core;
  class tools,wallets,network,mining operator;
```

The Gateway keeps sessions, routing, channels, and agent behavior in one place.

## Key capabilities

<Columns>
  <Card title="Multi-channel gateway" icon="network">
    Add WhatsApp, Telegram, Discord, iMessage, and more when you want remote chat surfaces.
  </Card>
  <Card title="User-run agent" icon="cpu">
    Sessions, tools, memory, plugins, and safety controls in one setup profile.
  </Card>
  <Card title="Plugin channels" icon="plug">
    Add Mattermost and more with extension packages.
  </Card>
  <Card title="Multi-agent routing" icon="route">
    Isolated sessions per agent, workspace, or sender.
  </Card>
  <Card title="Media support" icon="image">
    Send and receive images, audio, and documents.
  </Card>
  <Card title="Web Control UI" icon="monitor">
    Browser dashboard for chat, config, sessions, and nodes.
  </Card>
  <Card title="Fased Network and SAT mining" icon="coins">
    Add Fased Network and Satcoin mining after the base agent works.
  </Card>
  <Card title="Mobile nodes" icon="smartphone">
    Pair iOS and Android nodes with Canvas support.
  </Card>
</Columns>

## Choose Your Install

<Tabs>
  <Tab title="Local install">
    Use this for your laptop, desktop, dev box, or WSL2:

    ```bash
    curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash
    ```

    Then open the dashboard:

    ```bash
    fased dashboard
    ```

    Local setup keeps the Gateway on this machine. Tailscale is optional.

  </Tab>
  <Tab title="VPS Hosting install">
    Use this on the VPS that will run Fased all the time:

    ```bash
    curl -fsSL https://tailscale.com/install.sh | sh
    tailscale up --ssh

    curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --hosting
    ```

    Run those commands on the VPS itself. Open any Tailscale login URL from your
    local computer's browser. Before SSH/firewall lock-down, confirm that
    `ssh app@YOUR_VPS_TAILSCALE_NAME` reaches `/home/app/fased`.

  </Tab>
</Tabs>

Need the full install guide? See [Install](/install).
Want the Agent setup path after first boot? See [Fased Agent Setup](/start/fased).

## Dashboard

Open the browser Control UI after the Gateway starts.

- Local default: [http://localhost:18789/](http://localhost:18789/) (gateway still binds loopback)
- Remote access: [Web surfaces](/web) and [Tailscale](/gateway/tailscale)

## Configuration (optional)

Config lives at `~/.fased/fased.json`.

- If you **do nothing**, Fased uses the bundled Pi binary in RPC mode with per-sender sessions.
- If you want to lock it down, start with `channels.whatsapp.allowFrom` and (for groups) mention rules.

Example:

```json5
{
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
  messages: { groupChat: { mentionPatterns: ["@fased"] } },
}
```

## Start here

<Columns>
  <Card title="Docs hubs" href="/start/hubs" icon="book-open">
    All docs and guides, organized by use case.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="settings">
    Core Gateway settings, tokens, and provider config.
  </Card>
  <Card title="Install and operate" href="/install" icon="server">
    Install methods, deployment choices, and maintenance.
  </Card>
  <Card title="Wallets, Fased Network, and SAT" href="/start/fased" icon="shield">
    Add wallets, network participation, and mining after first-run setup.
  </Card>
  <Card title="Operator glossary" href="/start/operator-glossary" icon="book-open">
    Learn the shared wallet, mining, Fased Network, bond, and operator terms.
  </Card>
  <Card title="Remote access" href="/gateway/remote" icon="globe">
    SSH and tailnet access patterns.
  </Card>
  <Card title="Channels" href="/channels/telegram" icon="message-square">
    Channel-specific setup for WhatsApp, Telegram, Discord, and more.
  </Card>
  <Card title="Nodes" href="/nodes" icon="smartphone">
    iOS and Android nodes with pairing and Canvas.
  </Card>
  <Card title="Help" href="/help" icon="life-buoy">
    Common fixes and troubleshooting entry point.
  </Card>
</Columns>

## Learn more

<Columns>
  <Card title="Full feature list" href="/concepts/features" icon="list">
    Complete channel, routing, and media capabilities.
  </Card>
  <Card title="Multi-agent routing" href="/concepts/multi-agent" icon="route">
    Workspace isolation and per-agent sessions.
  </Card>
  <Card title="Security" href="/gateway/security" icon="shield">
    Tokens, allowlists, and safety controls.
  </Card>
  <Card title="Troubleshooting" href="/gateway/troubleshooting" icon="wrench">
    Gateway diagnostics and common errors.
  </Card>
  <Card title="Legal and risk" href="/reference/legal" icon="scale">
    License, third-party notices, and finance/crypto risk boundaries.
  </Card>
  <Card title="Origin and credits" href="/reference/credits" icon="info">
    Project origin and current attribution policy.
  </Card>
  <Card title="Roadmap" href="/reference/roadmap" icon="map">
    What comes after the current wallet, Fased Network, and operator tranche.
  </Card>
</Columns>
