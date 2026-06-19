---
summary: "Get Fased installed and run your first chat in minutes."
read_when:
  - First time setup from zero
  - You want the fastest path to a working chat
title: "Getting Started"
---

# Getting Started

Goal: go from zero to a first working chat with minimal setup.

<Warning>
If you plan to use wallet, mining, Fased Network, Marketplace, or other
wallet-connected features, read the repo risk boundary before moving funds or
enabling public participation:
[`docs/legal/disclaimer.md`](https://github.com/fased-ai/fased/blob/main/docs/legal/disclaimer.md).
</Warning>

<Info>
Fastest chat: open the Control UI (no channel setup needed). Run `fased dashboard`
and chat in the browser, or open `http://localhost:18789/` on the
<Tooltip headline="Gateway host" tip="The machine running the Fased gateway service.">gateway host</Tooltip>.
Docs: [Dashboard](/web/dashboard) and [Control UI](/web/control-ui).
</Info>

```mermaid
flowchart TD
  install["Install"] --> onboard["Onboard"]
  onboard --> dashboard["Dashboard"]
  dashboard --> model["Model"]
  model --> chat["First chat"]

  classDef setup fill:#120605,stroke:#ff5a36,color:#ffffff;
  classDef ui fill:#071018,stroke:#12cfff,color:#ffffff;
  classDef done fill:#20120a,stroke:#ffb020,color:#ffffff;
  class install,onboard setup;
  class dashboard,model ui;
  class chat done;
```

## Prereqs

- Linux, macOS, or Windows through WSL2
- Git access to the Fased repository

<Tip>
On Debian, Ubuntu, WSL Ubuntu, Fedora, and common RHEL-family systems, the
installer can install the needed command-line tools and Node runtime when they
are missing. On macOS, it can use Homebrew when Homebrew is already installed.
If you manage Node yourself, use Node 24, or Node 22.14+ with the built-in
`node:sqlite` module.
</Tip>

## Which install do I need?

<CardGroup cols={2}>
  <Card title="This computer" icon="monitor" href="#quick-setup-cli">
    Choose Local. Best for a laptop, desktop, dev box, WSL2, or first chat.
  </Card>
  <Card title="VPS / always-on server" icon="server" href="#quick-setup-cli">
    Choose Hosting. Create/sign into Tailscale first, then run the hosted
    installer on the VPS.
  </Card>
</CardGroup>

For the full decision table, read [Setup Matrix](/start/setup-matrix).
The macOS app is a Local setup surface, not a separate hosting profile.

## Quick setup (CLI)

<Steps>
  <Step title="Install Fased (recommended)">
    <Tabs>
      <Tab title="Local">
        ```bash
        curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash
        ```

        Use this for your laptop, desktop, dev box, macOS local setup, or WSL2.
        On Windows, install WSL2 first, then run this inside Ubuntu.

        After local setup:

        1. Keep the dashboard tab that opens, or run `fased dashboard`.
        2. Go to **Agent > Models** and connect a model provider.
        3. Open **Chat** and send a test message.

      </Tab>
      <Tab title="VPS Hosting">
        ```bash
        curl -fsSL https://tailscale.com/install.sh | sh
        tailscale up --ssh

        curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --hosting
        ```

        Run this **on the VPS itself**. If Tailscale prints a login URL in SSH,
        open that URL in your local computer's browser. Normal manual setup does
        not need a Tailscale API key. If you start as `root`, Fased bootstraps
        into `/home/app/fased` and continues as the `app` user. Before
        SSH/firewall lock-down, setup asks you to test this from your own
        computer:

        ```bash
        ssh app@YOUR_VPS_TAILSCALE_NAME
        ```

        Confirm only after it connects through Tailscale and opens
        `/home/app/fased`. At the end, open the printed Tailscale dashboard URL
        in your local browser and save the gateway token in case the browser
        asks for it.

        The `app` shell starts in `/home/app/fased`.
      </Tab>
    </Tabs>

    <Note>
    Other install methods and requirements: [Install](/install).
    </Note>

  </Step>
  <Step title="Run or continue onboarding">
    ```bash
    fased onboard --install-daemon
    ```

    `./install.sh` runs onboarding by default. Run this command only if you
    skipped onboarding, got interrupted, or want to reconfigure the daemon.

    The wizard configures workspace, Gateway, dashboard access, and optional
    wallet/mining setup. If you are setting up a VPS, use the Hosting install
    path above; a normal local `fased onboard` session cannot safely apply VPS
    SSH/firewall hardening.

    See [Onboarding Wizard](/start/wizard) for details.

  </Step>
  <Step title="Check the Gateway">
    If you installed the service, it should already be running:

    ```bash
    fased gateway status
    ```

  </Step>
  <Step title="Open the Control UI">
    ```bash
    fased dashboard
    ```

    The dashboard command opens an auth-ready local link such as
    `http://localhost:18789/#token=...`. The browser exchanges that fragment for
    a Control UI session and strips it from the address bar. If the browser asks
    for a token later, use the Gateway recovery token printed by onboarding.

    Continue setup in the browser from **Agents**:

    - `Agent > Models`: add a provider API key or sign in, then choose the Agent's primary and fallback models.
    - `Agent > Skills`: create, review, install, configure, edit, and allow skills for that Agent.
    - `Agent > Services`: connect Gmail, Calendar, GitHub, web/search, browser/media, or custom APIs.
    - `Agent > Channels`: connect chat apps and route them to the Agent.
    - `Agent > Memory`: enable session-memory and review this Agent's archive/QMD state.
    - `Agent > Tasks`: schedule recurring work for this Agent when needed.

    See [Control UI Setup Model](/start/control-ui-setup) for what belongs in
    onboarding, the browser UI, Advanced Config, and CLI.

  </Step>
  <Step title="Send the first browser chat">
    After `Agent > Models` shows a ready provider/model for the selected Agent,
    open **Chat**, choose the same Agent, and send a small test:

    ```text
    Reply with one sentence: Fased is ready.
    ```

    If it fails, fix the first visible blocker in this order:

    1. `Agent > Models`: provider auth or model selection
    2. `Logs`: provider/runtime error detail
    3. `Advanced > Debug`: raw diagnostics and repair tools

  </Step>
  <Step title="Update later">
    Normal updates use the stable release channel:

    ```bash
    fased update status
    fased update
    ```

    On a hosted VPS, run that as `app`:

    ```bash
    ssh app@YOUR_VPS_TAILSCALE_NAME
    cd /home/app/fased
    fased update status
    fased update
    ```

    Stable follows release tags. It does not pull every new `main` commit. Use
    `fased update --channel dev` only when intentionally tracking latest
    development commits.

  </Step>
</Steps>

<Check>
If the Control UI loads, your Gateway is ready for use.
</Check>

## Choose your next path

Once the dashboard is up, pick the path that matches your goal:

<CardGroup cols={3}>
  <Card title="Fased Agent first" href="/start/fased" icon="cpu">
    Use Fased Agent for sessions, tools, memory, and channels.
  </Card>
  <Card title="Wallet + Fased Network" href="/start/federation" icon="shield">
    Continue into wallet use, public routes, offers, and later bond setup.
  </Card>
  <Card title="SAT operator path" href="/plugins/crypto/mining-page" icon="coins">
    Create or import `@wallet:mining`, fund mining capital, and run Satcoin mining.
  </Card>
</CardGroup>

## Optional checks and extras

<AccordionGroup>
  <Accordion title="Run the Gateway in the foreground">
    Useful for quick tests or troubleshooting.

    ```bash
    fased gateway run --port 18789 --bind loopback
    ```

  </Accordion>
  <Accordion title="Send a test message">
    Requires a configured channel.

    ```bash
    fased message send --target +15555550123 --message "Hello from Fased"
    ```

  </Accordion>
</AccordionGroup>

## Useful environment variables

If you run Fased as a service account or want custom config/state locations:

- `FASED_HOME` sets the home directory used for internal path resolution.
- `FASED_STATE_DIR` overrides the state directory.
- `FASED_CONFIG_PATH` overrides the config file path.

Full environment variable reference: [Environment vars](/help/environment).

## Go deeper

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    Full CLI wizard reference and advanced options.
  </Card>
  <Card title="macOS local app" href="/start/onboarding">
    Apple-first Local setup surface for the same Local profile.
  </Card>
</Columns>

## What you will have

- A running Gateway
- A workspace and runtime identity
- Gateway token auth configured, with an auth-ready dashboard link for local setup
- A browser setup path for Agent model/provider auth
- Control UI access or a connected channel

## Next steps

- Run it as a real Agent setup: [Fased Agent Setup](/start/fased)
- Learn where setup belongs: [Control UI Setup Model](/start/control-ui-setup)
- DM safety and approvals: [Pairing](/channels/pairing)
- Connect more channels: open `Agent > Channels`
- Wallet, Fased Network, and SAT path: [Mining](/plugins/crypto/mining-page)
- Advanced workflows and from source: [Setup](/start/setup)
