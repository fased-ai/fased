---
summary: "Install Fased and send your first browser chat."
read_when:
  - You are setting up Fased for the first time
  - You want the shortest path to a working chat
title: "Getting Started"
---

# Getting Started

The shortest path is install, connect one model, and send one browser message.
You can add tools, channels and wallets later.

## 1. Install

<Tabs>
  <Tab title="Local">
    Run on Linux x86_64/arm64 with systemd, native macOS x86_64/arm64, or inside
    Ubuntu WSL2 x86_64. Windows users never run it in PowerShell:

    ```bash
    curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh | bash -s -- --local
    ```

    Administrator PowerShell is used only to run `wsl --install -d Ubuntu` and
    manage WSL. Reopen Ubuntu after any required restart, ensure systemd is
    active, and run the command above inside the Ubuntu shell. On macOS, run the
    command in Terminal. Linux arm64 and macOS are Local-only. Native Windows
    remains deferred. See [Windows](/platforms/windows) and [macOS](/platforms/macos).

  </Tab>

  <Tab title="VPS Hosting">
    First sign in to Tailscale on your own computer. SSH into a fresh VPS as
    root, then run:

    ```bash
    curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh \
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

## Next

Try [everyday tasks](/guide/everyday), choose [tools](/guide/tools), or read [troubleshooting](/guide/help) if setup fails.
