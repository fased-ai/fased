---
summary: "Fased macOS companion app (menu bar plus gateway broker)"
read_when:
  - Running Fased from the macOS menu bar app
  - Connecting local or remote Gateway access on macOS
  - Debugging macOS permissions, node features, or Gateway lifecycle
title: "macOS"
---

# Fased macOS

The macOS app is the menu-bar companion for Fased. It owns macOS permissions,
connects to a local or remote Gateway, and exposes Mac capabilities as a node.

Use it when you want native status, permission prompts, local node capabilities,
and one-click entry into the browser Control UI.

## What it does

- Shows native notifications and status in the menu bar.
- Owns TCC prompts (Notifications, Accessibility, Screen Recording, Microphone,
  Speech Recognition, Automation/AppleScript).
- Runs or connects to the Gateway (local or remote).
- Exposes macOS‑only tools (Canvas, Camera, Screen Recording, `system.run`).
- Starts the local node host service in **remote** mode and stops it in
  **local** mode.
- Optionally hosts **PeekabooBridge** for UI automation.
- Installs the `fased` CLI on request with the app installer; developers
  can still use the repo-backed `./install.sh --no-onboard` flow manually.

## Local vs remote mode

- **Local** (default): the app attaches to a running local Gateway if present;
  otherwise it enables the launchd service via `fased gateway install`.
- **Remote**: the app connects to a Gateway over SSH/Tailscale and does not
  start a local Gateway.
  The app starts the local **node host service** so the remote Gateway can reach
  this Mac.
  The app does not spawn the Gateway as a child process.

```mermaid
flowchart TD
  local["Local mode"] --> launchd["launchd Gateway"]
  local --> control["Control UI"]
  remote["Remote mode"] --> tunnel["SSH / tailnet tunnel"]
  remote --> node["local node host"]
  tunnel --> gateway["remote Gateway"]
  node --> gateway
  gateway --> control

  classDef mode fill:#10151f,stroke:#38bdf8,color:#e0f2fe;
  classDef bridge fill:#15110a,stroke:#f59e0b,color:#fff7ed;
  classDef runtime fill:#102016,stroke:#22c55e,color:#ecfdf5;
  class local,remote mode;
  class launchd,tunnel,node bridge;
  class gateway,control runtime;
```

## Launchd control

The app manages a per-user LaunchAgent labeled `ai.fased.gateway`
or `ai.fased.<profile>` when using `--profile`/`FASED_PROFILE`. Legacy
`com.fased.*` agents still unload.

```bash
launchctl kickstart -k gui/$UID/ai.fased.gateway
launchctl bootout gui/$UID/ai.fased.gateway
```

Replace the label with `ai.fased.<profile>` when running a named profile.

If the LaunchAgent isn’t installed, enable it from the app or run
`fased gateway install`.

## Node capabilities (mac)

The macOS app presents itself as a node. Common commands:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`,
  `canvas.a2ui.*`
- Camera: `camera.snap`, `camera.clip`
- Screen: `screen.record`
- System: `system.run`, `system.notify`

The node reports a `permissions` map so agents can decide what’s allowed.

Node service + app IPC:

- When the headless node host service is running in remote mode, it connects to
  the Gateway WebSocket as a node.
- `system.run` executes in the macOS app UI/TCC context over a local Unix socket;
  prompts and output stay in-app.

For protocol details, see [macOS IPC](/platforms/mac/xpc).

## Exec approvals (system.run)

`system.run` is controlled by **Exec approvals** in the app. Approval policy is
stored locally on the Mac in:

```
~/.fased/exec-approvals.json
```

Key behavior:

- Allowlist entries match resolved binary paths.
- Shell control syntax requires explicit approval unless the shell path is
  already allowed.
- Environment overrides are filtered before the command runs.
- "Always Allow" persists the approved executable path where it can be resolved
  cleanly.

For the security model, see [Gateway security](/gateway/security).

## Deep links

The app registers the `fased://` URL scheme for local actions.

### `fased://agent`

Triggers a Gateway `agent` request.

```bash
open 'fased://agent?message=Hello%20from%20deep%20link'
```

Without an unattended key, the app asks for confirmation and keeps the request
bounded. With a valid key, the request can run unattended for personal
automation.

## Onboarding flow (typical)

1. Install and launch **FasedAgent.app**.
2. Complete the permissions checklist (TCC prompts).
3. Ensure **Local** mode is active and the Gateway is running.
4. Open `http://localhost:18789` for the Control UI.
5. Finish normal setup in **Agents**: choose model refs, channel accounts,
   skills, tools, memory, and tasks for the selected Agent.
6. Install the CLI if you want terminal access.

## Build & dev workflow (native)

- `cd apps/macos && swift build`
- `swift run FasedAgent` (or Xcode)
- Package app: `scripts/package-mac-app.sh`

## Debug gateway connectivity (macOS CLI)

Use the debug CLI to test the same Gateway handshake and discovery path the app
uses.

```bash
cd apps/macos
swift run fased-mac connect --json
swift run fased-mac discover --timeout 3000 --json
```

Compare with `fased gateway discover --json` when Bonjour or tailnet discovery
does not match the app.

## Remote connection plumbing (SSH tunnels)

Remote mode uses either an SSH tunnel or a direct private Gateway URL. For setup
steps, see [macOS remote access](/platforms/mac/remote). For protocol details,
see [Gateway protocol](/gateway/protocol).

## Related docs

- [Gateway runbook](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS permissions](/platforms/mac/permissions)
- [macOS remote access](/platforms/mac/remote)
- [Canvas](/platforms/mac/canvas)
