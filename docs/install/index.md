---
summary: "Install Fased on your computer or a fresh always-on VPS."
read_when:
  - You want to install Fased
  - You need to choose between Local and VPS Hosting
title: "Install"
---

# Install

Choose one runtime. Local runs on your computer. VPS Hosting stays online on a
remote Linux server.

<Tabs>
  <Tab title="Local">
    Run this on Linux x86_64 or arm64 with systemd, including inside Ubuntu
    WSL2 x86_64:

    ```bash
    curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh | bash -s -- --local
    ```

    Local binds the Gateway to loopback and does not install or prompt for
    Tailscale. On Windows, provision Ubuntu WSL2 in Administrator PowerShell,
    then run this command inside the Ubuntu shell. On macOS, run it in Terminal.
    Linux arm64 and macOS are Local-only; native Windows is deferred.

  </Tab>

  <Tab title="VPS Hosting">
    Use a fresh x86_64 Ubuntu LTS VPS for the simplest path (Rocky-compatible
    x86_64 is the retained alternative). SSH into its root shell, then run:

    ```bash
    curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh \
      | bash -s -- --hosting
    ```

    The installer selects and verifies one stable tagged Hosting release before
    it creates persistent Fased state. Follow the [three-step VPS guide](/install/vps)
    for the Tailscale and SSH steps.

  </Tab>
</Tabs>

<Note>
The VPS command runs inside the VPS provider's root shell. Your own computer
may use any OS to perform the later Tailscale and SSH access check.
</Note>

## After installation

1. Connect a model under **Agent > Models**.
2. Send a test message in **Chat**.
3. Add channels, wallets, skills, or Mining only when needed.

```bash
fased health
fased dashboard
```

Normal updates use:

```bash
fased update
```

<AccordionGroup>
  <Accordion title="Local or Hosting?">
    | Path | Runs where | Private access | Normal operator |
    | --- | --- | --- | --- |
    | Local | Linux x86_64/arm64 with systemd, Ubuntu WSL2 x86_64, or macOS x86_64/arm64 | Loopback on the local OS | Your OS account; Gateway and signer use isolated services |
    | VPS Hosting | Ubuntu or Rocky-compatible x86_64 | Tailscale plus provider-console recovery | `app`; Gateway is isolated as `fased-gateway` |
  </Accordion>

  <Accordion title="What the streamed installer trusts">
    The convenience command trusts HTTPS, GitHub Releases, and the Fased GitHub
    release publisher for `install.sh`, because Bash executes that shell before
    an installed Fased trust root exists. Its stamped digest binds the Go
    bootstrap downloaded afterward, but cannot authenticate a shell that has
    already been replaced. The Go bootstrap then verifies the signed release
    channel, exact descriptors, artifacts, and rollback floors before managed
    product mutation.

    To verify `install.sh` before Bash runs it, use
    [Advanced exact-tag verification](/install/installer#exact-tag-pre-execution-verification).

  </Accordion>

  <Accordion title="Interrupted setup or repair">
    Use the installed updater for normal Hosting updates. If a legacy root
    controller cannot replace itself or setup was interrupted, rerun the same
    streamed `--hosting` command from the provider root console. It verifies
    immutable release assets, detects existing state, selects the internal
    repair path, and skips onboarding. See
    [Hosting recovery](/install/installer#hosting-repair-and-recovery).
  </Accordion>
</AccordionGroup>

## More guides

<CardGroup cols={2}>
  <Card title="VPS Hosting" href="/install/vps" icon="server">
    Three normal steps, access checks, and collapsed troubleshooting.
  </Card>
  <Card title="Windows and WSL2" href="/platforms/windows" icon="windows">
    Ubuntu WSL2 x86_64 is supported with systemd and Linux-owned state under
    `/home`. Native Windows remains deferred. Linux arm64 and macOS are Local-only.
  </Card>
  <Card title="Advanced installer" href="/install/installer" icon="terminal">
    Exact-tag verification, flags, restrictions, repair, and recovery.
  </Card>
  <Card title="Updating" href="/install/updating" icon="refresh-cw">
    Stable updates and rollback behavior.
  </Card>
</CardGroup>
