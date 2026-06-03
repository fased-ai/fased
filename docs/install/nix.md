---
summary: "Run Fased declaratively with Nix"
read_when:
  - You want reproducible, rollback-able installs
  - You're already using Nix/NixOS/Home Manager
  - You want everything pinned and managed declaratively
title: "Nix"
---

# Nix Installation

There is currently **no separate public `nix-fased` repository**.
This page documents how to run Fased declaratively if you already use Nix,
NixOS, or Home Manager and want to package the main repo yourself.

## Quick Start

If you want a Nix-based install, the practical order is:

```text
1. Install Determinate Nix or your preferred Nix distribution
2. Clone the main repo: github.com/fased-ai/fased
3. Pin Node, pnpm, and Swift (if you need the macOS app) in your flake or devShell
4. Point FASED_STATE_DIR and FASED_CONFIG_PATH at writable locations
5. Install the CLI with ./install.sh --no-onboard or your own wrapper
6. Verify launchd / systemd / CLI behavior from your Nix-managed setup
```

If you maintain your own flake or Home Manager module, this page is the runtime
constraints reference you should align to.

## What a Nix wrapper can manage

- Node, pnpm, and the Fased CLI/runtime pinned in your own flake or module
- Launchd or systemd service wiring managed by your host config
- Config and state paths kept outside the immutable store
- Rollback through your normal Nix or Home Manager workflow

---

## Nix Mode Runtime Behavior

When `FASED_NIX_MODE=1` is set:

Fased supports a **Nix mode** that makes configuration deterministic and disables auto-install flows.
Enable it by exporting:

```bash
FASED_NIX_MODE=1
```

On macOS, the GUI app does not automatically inherit shell env vars. You can
also enable Nix mode via defaults:

```bash
defaults write ai.fased.mac fased.nixMode -bool true
```

### Config + state paths

Fased reads JSON5 config from `FASED_CONFIG_PATH` and stores mutable data in `FASED_STATE_DIR`.
When needed, you can also set `FASED_HOME` to control the base home directory used for internal path resolution.

- `FASED_STATE_DIR` (default: `~/.fased`)
- `FASED_CONFIG_PATH` (default: `$FASED_STATE_DIR/fased.json`)

When running under Nix, set these explicitly to Nix-managed locations so runtime state and config
stay out of the immutable store.

### Runtime behavior in Nix mode

- Auto-install and self-mutation flows are disabled
- Missing dependencies surface Nix-specific remediation messages
- UI surfaces a read-only Nix mode banner when present

## Packaging note (macOS)

The macOS packaging flow expects a stable Info.plist template at:

```
apps/macos/Sources/FasedAgent/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/fased-ai/fased/blob/main/scripts/package-mac-app.sh) copies this template into the app bundle and patches dynamic fields
(bundle ID, version/build, Git SHA, Sparkle keys). This keeps the plist deterministic for SwiftPM
packaging and Nix builds (which do not rely on a full Xcode toolchain).

## Related

- [Main repository](https://github.com/fased-ai/fased)
- [Wizard](/start/wizard) — non-Nix CLI setup
- [Docker](/install/docker) — containerized setup
