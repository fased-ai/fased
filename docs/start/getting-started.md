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
flowchart LR
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

- Node 24 recommended, or Node 22.14+ with the built-in `node:sqlite` module

<Tip>
Check your runtime with `node --version` and
`node -e 'require("node:sqlite"); console.log("node:sqlite ok")'` if you are unsure.
</Tip>

## Which install do I need?

<CardGroup cols={3}>
  <Card title="This computer" icon="monitor" href="#quick-setup-cli">
    Choose Local. Best for a laptop, desktop, dev box, WSL2, or first chat.
  </Card>
  <Card title="VPS / always-on server" icon="server" href="#quick-setup-cli">
    Choose Hosting. Create/sign into Tailscale first, then run the hosted
    installer on the VPS.
  </Card>
  <Card title="macOS app" icon="apple" href="/start/onboarding">
    Use the app-first flow, then finish models, skills, channels, and tasks in
    the Control UI.
  </Card>
</CardGroup>

For the full decision table, read [Setup Matrix](/start/setup-matrix).

## Quick setup (CLI)

<Steps>
  <Step title="Install Fased (recommended)">
    <Tabs>
      <Tab title="Local">
        ```bash
        git clone https://github.com/fased-ai/fased.git fased
        cd fased
        ./install.sh
        ```

        Use this for your laptop, desktop, dev box, or WSL2.

      </Tab>
      <Tab title="VPS Hosting">
        ```bash
        curl -fsSL https://tailscale.com/install.sh | sh
        sudo tailscale up --ssh

        git clone https://github.com/fased-ai/fased.git fased
        cd fased
        ./install.sh --hosting
        ```

        Run this **on the VPS itself**. If Tailscale prints a login URL in SSH,
        open that URL in your local computer's browser. Normal manual setup does
        not need a Tailscale API key. If you start as `root`, Fased bootstraps
        into `/home/app/fased` and continues as the `app` user. At the end,
        open the printed Tailscale dashboard URL in your local browser and save
        the gateway token in case the browser asks for it. Use Tailscale SSH as
        `app` for CLI commands, updates, logs, and repairs:

        ```bash
        tailscale ssh app@YOUR_VPS_TAILSCALE_NAME
        fased dashboard
        ```

        The `app` shell starts in `/home/app/fased`.

      </Tab>
      <Tab title="Windows">
        Use [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install), then run the same installer inside Ubuntu:

        ```bash
        git clone https://github.com/fased-ai/fased.git fased
        cd fased
        ./install.sh
        ```
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
</Steps>

<Check>
If the Control UI loads, your Gateway is ready for use.
</Check>

## Choose your next path

Once the dashboard is up, pick the path that matches your goal:

<CardGroup cols={3}>
  <Card title="Fased Agent first" href="/start/fased" icon="cpu">
    Use Fased as your self-hosted Agent runtime with sessions, tools, and channels.
  </Card>
  <Card title="Wallet + Fased Network" href="/start/federation" icon="shield">
    Continue into wallet policy, hosted reachability, trusted network participation, and bond operator setup.
  </Card>
  <Card title="SAT operator path" href="/plugins/crypto/mining-page" icon="coins">
    Create or import `@wallet:mining`, fund capital, and run the SAT mining workflow.
  </Card>
</CardGroup>

## Optional checks and extras

<AccordionGroup>
  <Accordion title="Run the Gateway in the foreground">
    Useful for quick tests or troubleshooting.

    ```bash
    fased gateway --port 18789
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
  <Card title="macOS app onboarding" href="/start/onboarding">
    First run flow for the macOS app.
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
