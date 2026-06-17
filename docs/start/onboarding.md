---
summary: "First-run onboarding flow for Fased (macOS app)"
read_when:
  - Designing the macOS onboarding assistant
  - Implementing auth or identity setup
title: "Onboarding (macOS App)"
sidebarTitle: "Onboarding: macOS App"
---

# Onboarding (macOS App)

This doc describes the **current** first-run onboarding flow. The goal is a
smooth “day 0” experience: pick where the Gateway runs, make the host reachable
and safe, run the wizard, and then finish model/provider and Agent setup in
the Control UI.
For the Local, Hosting, and Remote consequences used by the CLI wizard and
install flow, see [First-run Setup Matrix](/start/setup-matrix).

<Steps>
<Step title="Approve macOS warning">
Approve the initial macOS trust warning so the app can launch and continue onboarding.
</Step>
<Step title="Approve find local networks">
Approve local network discovery so the app can find or talk to the local Gateway runtime.
</Step>
<Step title="Welcome and security notice">
Read the security notice shown in the app and decide whether this machine should
stay a private single-operator runtime or be hardened for a more shared setup.

Security trust model:

- By default, Fased is a single-operator Agent: one trusted operator boundary.
- Shared/multi-user setups require lock-down. Split trust boundaries, keep tool
  access minimal, and follow [Security](/gateway/security).

</Step>
<Step title="Local vs Remote">
Where does the **Gateway** run?

- **This Mac (Local only):** onboarding configures the local runtime, Gateway,
  and optional local signer wallet state.
- **Remote (over SSH/Tailnet):** onboarding does **not** configure local auth;
  credentials must exist on the gateway host.
- **Configure later:** skip setup and leave the app unconfigured.

The CLI installer also has a **Hosting** profile for VPS/always-on servers.
Hosting applies server-style Tailscale, firewall, and SSH behavior. Local on a
VPS means no hosting hardening; Hosting on a personal Linux machine can change
that machine's SSH/firewall behavior.

<Tip>
**Gateway auth tip:**

- The wizard now generates a **token** even for loopback, so local WS clients must authenticate.
- Local first open should use `fased dashboard` or the onboarding link; those
  links carry the token in a URL fragment and exchange it for a browser session.
- If you disable auth, any local process can connect; use that only on fully trusted machines.
- Use a **token** for multi‑machine access or non‑loopback binds.

</Tip>
</Step>
<Step title="Control UI setup">
After the Gateway is online, use the Control UI for product setup:

- `Agent > Models`: add model API keys or sign in.
- `Agent > Skills`: create, review, install, configure, edit, and allow skills.
- `Agent > Channels`: connect messaging apps and assign routes.
- `Agent > Services`: connect web/search, Gmail, Calendar, GitHub, browser/media, and APIs.
- `Agent > Memory` and `Agent > Tasks`: enable archives and schedules when needed.

</Step>
<Step title="Permissions">
Choose which macOS permissions you want to grant to Fased.

Onboarding requests TCC permissions needed for:

- Automation (AppleScript)
- Notifications
- Accessibility
- Screen Recording
- Microphone
- Speech Recognition
- Camera
- Location

</Step>
<Step title="CLI">
  <Info>This step is optional</Info>
  The app can install the `fased` CLI so terminal workflows and launchd tasks
  work out of the box.
</Step>
<Step title="Onboarding Chat (dedicated session)">
  After setup, the app opens a dedicated onboarding chat session so the agent can
  introduce itself and guide next steps. This keeps first‑run guidance separate
  from your normal conversation. See [Bootstrapping](/start/bootstrapping) for
  what happens on the gateway host during the first agent run.
</Step>
</Steps>
