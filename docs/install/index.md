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
    Run this in macOS Terminal, a Linux terminal, or an Ubuntu WSL2 shell:

    ```bash
    curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --local
    ```

    Native Windows is not a Local runtime. Install and run Fased inside
    [WSL2 Ubuntu](/platforms/windows), not PowerShell, Command Prompt, Git Bash,
    or native Windows Node.js. Tailscale is optional for Local.

  </Tab>

  <Tab title="VPS Hosting">
    Use a fresh Ubuntu LTS VPS for the simplest path. SSH into its root shell,
    then run exactly:

    ```bash
    curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \
      | bash -s -- --hosting
    ```

    The installer selects and verifies one stable tagged Hosting release before
    it creates persistent Fased state. Follow the [three-step VPS guide](/install/vps)
    for the Tailscale and SSH steps.

  </Tab>
</Tabs>

<Note>
The VPS command runs inside the VPS provider's root shell. Windows users may
manage a VPS from PowerShell; WSL2 is required only when Fased itself runs
locally on Windows.
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
    | Local | macOS, Linux, or WSL2 Ubuntu | Local OS; Tailscale optional | Your OS account; protected Linux uses isolated Gateway/signer services |
    | VPS Hosting | Ubuntu/Fedora/RHEL-family systemd VPS | Tailscale plus provider-console recovery | `app`; Gateway is isolated as `fased-gateway` |
  </Accordion>

  <Accordion title="What the streamed installer trusts">
    The mutable `main/install.sh` bootstrap begins running over HTTPS before it
    can authenticate itself. Its fresh Hosting path is deliberately small: it
    rejects overrides and verifies the release workflow, tag, signed manifest,
    app layer, dependency layer, signer, architecture, commit, digests, and
    archive layout before persistent Fased changes.

    To verify `install.sh` before Bash runs it, use
    [Advanced exact-tag verification](/install/installer#exact-tag-pre-execution-verification).

  </Accordion>

  <Accordion title="Interrupted setup or repair">
    A streamed `--hosting` command is fresh-install-only. Use the installed
    updater for normal Hosting updates. Existing-host repair is exact-tag-only;
    follow [Hosting recovery](/install/installer#hosting-repair-and-recovery).
  </Accordion>
</AccordionGroup>

## More guides

<CardGroup cols={2}>
  <Card title="VPS Hosting" href="/install/vps" icon="server">
    Three normal steps, access checks, and collapsed troubleshooting.
  </Card>
  <Card title="Windows (WSL2)" href="/platforms/windows" icon="windows">
    Keep PowerShell and Ubuntu commands separate.
  </Card>
  <Card title="Advanced installer" href="/install/installer" icon="terminal">
    Exact-tag verification, flags, restrictions, repair, and recovery.
  </Card>
  <Card title="Updating" href="/install/updating" icon="refresh-cw">
    Stable updates and rollback behavior.
  </Card>
</CardGroup>
