---
summary: "macOS Skills settings UI and gateway-backed status"
read_when:
  - Updating the macOS Skills settings UI
  - Changing skills gating or install behavior
title: "Skills"
---

# Skills (macOS)

The macOS app surfaces Fased skills through the gateway; it does not parse
`SKILL.md` files itself. The complete source of truth is the browser Control UI:
**Agent > Skills** for the selected Agent. The macOS settings panel is a compact
operator view for status, dependency install, environment values, and enable
state.

## Data source

- `skills.status` (gateway) returns all skills plus eligibility and missing requirements.
- Requirements are derived from `metadata.fased.requires` in each `SKILL.md`.
- Agent allowlists are per-Agent. Installing a skill into the library does not
  automatically grant an Agent access to it.

## Install actions

- `metadata.fased.install` defines install options (brew/node/go/uv).
- The app calls `skills.install` on the currently connected gateway. In remote
  mode, **Install on Gateway** runs on the remote gateway host. **Install on This
  Mac** switches to local mode and runs the same gateway-backed installer
  against this Mac.
- Install is not considered ready until the required binary/config is visible to
  the gateway runtime. A successful package-manager exit is not enough.
- Homebrew is optional. On Linux/WSL, skills should prefer npm/go/uv/apt-style
  instructions when available, or show a manual setup message.

## Config and grants

- Skill-local config lives under `skills.entries.<skillKey>`.
- Root config requirements, such as a channel token, should be shown as typed
  fields that write the real config path.
- Wallet and mining permissions are never granted by install. Wallet-capable
  skills require explicit review in **Wallets → Access / Skill Grants**.

## Remote mode

- Install + config updates happen on the gateway host (not the local Mac).
- If the Mac is only a remote controller, the dependency must be on the remote
  host PATH, not the local Mac PATH.
