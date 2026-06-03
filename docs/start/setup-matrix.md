---
summary: "First-run setup matrix for local and hosting Fased Agent installs"
read_when:
  - Choosing local or hosting onboarding
  - Choosing local gateway or remote gateway connection mode
  - Explaining what setup belongs in onboarding, Control UI, and CLI
title: "First-run Setup Matrix"
sidebarTitle: "Setup Matrix"
---

# First-run Setup Matrix

Use this page before `install.sh` or `fased onboard`.

The main choice is where the **Gateway** runs. The Gateway is the process that
the Control UI, CLI, channels, skills, wallets, and future Agents talk to.

## Choose The Right Host Setup Profile

```mermaid
flowchart LR
  machine["Where will Gateway run?"] --> local["Laptop / desktop"]
  machine --> hosting["VPS / always-on server"]
  local --> localProfile["Local profile"]
  hosting --> tailscale["Tailscale first"]
  tailscale --> hostingProfile["Hosting profile"]

  classDef question fill:#071018,stroke:#12cfff,color:#ffffff;
  classDef localLane fill:#120605,stroke:#ff5a36,color:#ffffff;
  classDef hostLane fill:#20120a,stroke:#ffb020,color:#ffffff;
  class machine question;
  class local,localProfile localLane;
  class hosting,tailscale,hostingProfile hostLane;
```

| Choice  | Use when                                            | What it changes                                                                                                                                                                                                              | Wrong choice risk                                                                                                                                     |
| ------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local   | The agent runs on this laptop, desktop, or dev box. | Creates local config, workspace, gateway settings, local signer/wallet state if selected, and local service startup. Tailscale is not part of the basic Local path.                                                          | Local on a VPS means no SSH/firewall hardening. It can still run, but it does not apply the hosting security baseline.                                |
| Hosting | The agent runs on a VPS or always-on server.        | Uses the local runtime setup plus hosting hardening: Tailscale-first admin access, firewall policy, SSH hardening, fail2ban/unattended-upgrades where supported, and hosted gateway service behavior. Tailscale is required. | Hosting on personal Linux changes SSH/firewall behavior. Do not choose it on your daily machine unless you intentionally want server-style hardening. |

<Warning>
If you are SSH'd into a VPS and choose **Local**, Fased will not protect that
host like a hosted node. If you choose **Hosting** on your personal Linux
workstation, the wizard may change firewall and SSH behavior for that machine.
</Warning>

<Note>
For the normal Hosting path you usually do not need a Tailscale API key. Create
or sign into a Tailscale account, join the host to your tailnet with the
`tailscale` CLI, then run Fased onboarding. Tailscale API/auth keys are only for
automated provisioning. See [Tailscale](/gateway/tailscale) and the VPS install
guides for the detailed host steps.
</Note>

<Tip>
Simple VPS order: create server → `sudo tailscale up --ssh` → `./install.sh --hosting`.
If the wizard asks for a Tailscale auth key, choose no unless you are doing
scripted provisioning. The Tailscale CLI can show a login URL in SSH; open that
URL in your local computer's browser, then return to the SSH session.
</Tip>

## Actual Interactive Wizard Order

The current CLI wizard order is:

1. Choose QuickStart or Manual.
2. Read the setup map, then choose Local or Hosting profile.
3. If config already exists, choose update settings or repair auth/sessions.
4. Choose workspace directory.
5. Configure Gateway port, bind address, and auth.
6. Configure Fased Network / federation when selected.
7. Build or configure native signer support, then configure wallet roles and the optional singleton Mining wallet.
8. Write config and bootstrap workspace/session state.
9. Apply hosting security only when the Hosting profile is selected. Hosting requires Tailscale.
10. Run final daemon, health, Control UI, and readiness steps.

`install.sh` installs dependencies, builds the runtime, installs the CLI, and
then runs the onboarding wizard with daemon setup unless you pass `--no-onboard`.

## What Each Step Is For

| Step          | Purpose                                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model         | Needed before the agent can answer. Add it after onboarding in `Agent > Models`, then use it in Chat or tasks.                                              |
| Provider auth | Stores API/OAuth credentials or references for model providers. Ordinary setup belongs in `Agent > Models`.                                                 |
| Gateway       | The connection point for Control UI, CLI, WebChat, channels, and remote clients.                                                                            |
| Tailscale     | Hidden from the basic Local path. Required for Hosting profile admin access.                                                                                |
| Channels      | External apps like Telegram, Discord, WhatsApp, and Slack. Connect them after onboarding in `Agent > Channels`, then route each account to an Agent.        |
| Wallet        | Policy-bound actions for sends, receipts, mining, Marketplace, and reviewed wallet-connected workflows. Not required for normal chat.                       |
| Skills        | Agent abilities. Configure, edit, install, and allow them after onboarding in `Agent > Skills`.                                                             |
| Plugins       | Runtime extensions. Install/review after onboarding in Control UI > Extensions.                                                                             |
| Hooks         | Background automation that runs around agent events. Enable `session-memory` after onboarding in `Agent > Memory`.                                          |
| Memory        | Workspace memory files, session archives, and optional QMD-backed indexing/export. Memory diagnostics are read-only in the UI; repair remains in Debug/CLI. |

## Onboarding vs Control UI vs CLI

| Area                      | Onboarding                                                      | Control UI                                                                                                                                                            | CLI                                                               |
| ------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| First working model       | Not normal onboarding.                                          | `Agent > Models` adds provider auth when needed and saves the Agent's primary/fallback/task model refs.                                                               | `fased configure`, provider/auth commands, and env/profile files. |
| Gateway access            | Choose port, bind, auth, token/password, and Hosting Tailscale. | Dashboard shows compact Gateway access; Debug owns raw diagnostics.                                                                                                   | `fased dashboard`, `fased status`, `fased doctor`.                |
| Channels                  | Optional setup prompt.                                          | `Agent > Channels` lists the onboarding-order channels, exposes setup/status/start-stop/probe controls, and assigns routes to Agents. Channels do not own Tasks.      | Channel-specific config commands.                                 |
| Services                  | Not normal onboarding.                                          | `Agent > Services` owns connector setup/status for web/search, Gmail/Calendar, GitHub, browser/media, plugin-reported APIs, and task needs-access recovery.           | Service-specific CLI/config commands.                             |
| Wallet / Mining / Network | Optional setup, role assignment, and readiness summary.         | Wallet, Mining, and Fased Network stay separate source-of-truth pages. `/agents` may show their setup status but should load the same live data.                      | Wallet, mining, and federation commands.                          |
| Skills                    | Not normal onboarding.                                          | `Agent > Skills` separates bundled, ready, needs API key, needs dependency, needs config, disabled, and blocked, and stores the selected Agent's skill access policy. | `fased skills` plus config/env setup.                             |
| Plugins                   | Not normal onboarding.                                          | Extensions/Plugins page owns source trust, plugin-catalog activation, dependency/script warnings, scanners, and update review.                                        | `fased plugins`.                                                  |
| Hooks                     | Not normal onboarding.                                          | Extensions owns hook pack lifecycle. Agent memory archive control lives in Agent > Memory; external webhook task triggers should move to Tasks later.                 | `fased hooks`.                                                    |
| Memory                    | Not normal onboarding.                                          | Memory page is read-only diagnostics and QMD overview. Agent > Memory owns session-memory activation and mirrors QMD setup.                                           | `fased memory` and Debug repair flows.                            |
| Tasks                     | Not required for first chat.                                    | Tasks are created from Chat, channels, Agent > Tasks, or task deep links. Runtime still uses cron internally, but UI should say Tasks.                                | Task/cron commands where available.                               |

## Post-onboarding Control UI Shape

After onboarding, use `/agents` as the single **Agent Setup** checklist:

```text
Model connected
Provider auth ready
Memory archive on/off
Skills ready or needs setup
Channels connected
Wallet policy
Task bindings
```

Dashboard should stay a launch/control widget board. It should not duplicate the
full setup wizard. Debug keeps raw diagnostics, repair previews, provider
catalog dumps, plugin runtime warnings, and low-level RPC surfaces.

For page-by-page browser setup ownership, read
[Control UI Setup Model](/start/control-ui-setup).
