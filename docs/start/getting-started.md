---
summary: "Install Fased and send your first browser chat."
read_when:
  - You are setting up Fased for the first time
  - You want the shortest path to a working chat
title: "Getting Started"
---

# Getting Started

The shortest path is install, connect one model, and send one browser message.
Wallets, channels, skills, and Mining can wait.

## 1. Install

<Tabs>
  <Tab title="Local">
    Run in macOS Terminal, a Linux terminal, or Ubuntu WSL2:

    ```bash
    curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --local
    ```

    Native Windows uses [WSL2 Ubuntu](/platforms/windows). Do not run this Bash
    command in PowerShell or native Windows Node.js.

  </Tab>

  <Tab title="VPS Hosting">
    First sign in to Tailscale on your own computer. SSH into a fresh VPS as
    root, then run:

    ```bash
    curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \
      | bash -s -- --hosting
    ```

    Continue with the [VPS Hosting guide](/install/vps) for its private SSH
    check and recovery boundary.

  </Tab>
</Tabs>

The installer runs onboarding. If onboarding was skipped or interrupted:

```bash
fased onboard --install-daemon
```

## 2. Open Fased

```bash
fased health
fased dashboard
```

On Hosting, reconnect as the `app` operator through Tailscale before running
those commands. The Gateway itself runs under the isolated `fased-gateway`
account.

## 3. Connect a model

In the Control UI:

1. Open **Agent > Models**.
2. Sign in or add one provider API key.
3. Choose the Agent's primary model.

## 4. Send the first chat

Open **Chat**, choose the same Agent, and send:

```text
Reply with one sentence: Fased is ready.
```

If it fails, check **Agent > Models**, then **Logs**.

<Check>
If the browser receives the reply, the first-run path is complete.
</Check>

## Add only what you need

<CardGroup cols={2}>
  <Card title="Channels" href="/channels" icon="message-circle">
    Connect Telegram, Discord, WhatsApp, Slack, or another supported chat app.
  </Card>
  <Card title="Wallets" href="/plugins/crypto/wallet-page" icon="wallet">
    Create a role-ready Agent, Mining, or Vault wallet.
  </Card>
  <Card title="Mining" href="/plugins/crypto/mining-page" icon="coins">
    Verify SAT runtime readiness, fund the Mining wallet, and start Mining.
  </Card>
  <Card title="Skills" href="/tools/skills" icon="blocks">
    Install a skill, then grant wallet authority separately if it needs any.
  </Card>
</CardGroup>

<AccordionGroup>
  <Accordion title="What installs where">
    Local runs under your OS account. Hosting separates the human `app`
    operator, `fased-gateway` service, and `fased-signer` service. Root is only
    for first bootstrap and exact-tag emergency repair.
  </Accordion>

  <Accordion title="Update later">
    ```bash
    fased update status
    fased update
    ```

    Stable release tags are the default. The development channel is an explicit
    opt-in.

  </Accordion>

  <Accordion title="Wallet and Mining risk boundary">
    Choose wallet roles explicitly and keep only working value in hot roles.
    Never paste private keys or recovery passwords into chat or the ordinary
    browser UI. Read the [wallet roles](/plugins/crypto/wallet-roles-and-policies)
    and [risk disclaimer](/legal/disclaimer) before moving funds.
  </Accordion>
</AccordionGroup>

## Next

- [Install choices and recovery](/install)
- [Onboarding details](/start/wizard)
- [Control UI](/web/control-ui)
- [Agent, wallet, and Mining walkthrough](/start/agent-wallet-mining-walkthrough)
