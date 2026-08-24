---
summary: "Gateway runtime on macOS (external launchd service)"
read_when:
  - Packaging the macOS app bundle
  - Debugging the macOS gateway launchd service
  - Installing the gateway CLI for macOS
title: "Gateway on macOS"
---

# Gateway on macOS (managed launchd)

Managed macOS Local installation uses root-managed system LaunchDaemons and the
same signed lifecycle protocol as Linux. The companion app attaches to that
Gateway; it is not the lifecycle owner.

## Install the managed CLI and Gateway

Run in Terminal as the ordinary macOS user:

```bash
curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh \
  | bash -s -- --local
```

The release bundles Node and native Darwin binaries. Homebrew and a source
checkout are not required.

## launchd (managed system services)

Managed plist location: `/Library/LaunchDaemons`.

Manager:

- The Go lifecycle owns the system LaunchDaemons transactionally.
- The app attaches to the managed Gateway and does not replace its service.

Behavior:

- `fased` and the Go lifecycle manage the system LaunchDaemons; the companion
  app does not enable, disable, replace, or repair them.
- App quit does **not** stop the Gateway (`launchd` keeps it alive).
- If a Gateway is already running on the configured port, the app attaches to
  it instead of starting a new one.

Logging:

- Managed service logs are owned by the installed lifecycle. Use `fased status`
  and `fased doctor --non-interactive` for user-facing diagnostics.

## Version compatibility

The macOS app checks the Gateway version against its own version. Managed Local
acceptance requires the platform-qualified Darwin release assets and matching
Gateway, signer, and lifecycle identities.

## Source-development smoke check

The following manual Gateway command is for contributor/source development; it
does not replace managed Local acceptance:

```bash
fased --version

FASED_SKIP_CHANNELS=1 \
FASED_SKIP_CANVAS_HOST=1 \
fased gateway --port 18999 --bind loopback
```

Then:

```bash
fased gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
