---
summary: "Setup guide for developers working on the Fased macOS app"
read_when:
  - Setting up the macOS development environment
title: "macOS Dev Setup"
---

# macOS Developer Setup

This guide covers the steps required to build and run the Fased macOS app from
source.

## Prerequisites

Before building the app, ensure you have the following installed:

1. **Xcode 26.2+**: Required for Swift development.
2. **Node.js 24 recommended, or Node 22.14+ with `node:sqlite`, plus pnpm**:
   required for the gateway, CLI, and packaging scripts.

## 1. Install Dependencies

Install the project-wide dependencies:

```bash
pnpm install
```

## 2. Build and Package the App

To build the macOS app and package it into `dist/FasedAgent.app`, run:

```bash
./scripts/package-mac-app.sh
```

If you don't have an Apple signing certificate, the script fails by default. Set
`ALLOW_ADHOC_SIGNING=1` only for fast local builds where macOS permissions do
not need to persist.

For dev run modes, signing flags, and Team ID troubleshooting, see the
[macOS app README](https://github.com/fased-ai/fased/blob/main/apps/macos/README.md).

> **Note**: Ad-hoc signed apps may trigger security prompts. If the app crashes
> immediately with "Abort trap 6", see the [Troubleshooting](#troubleshooting)
> section.

## 3. Install the CLI

Managed macOS Local installation uses the public installer. For development,
use the repo-backed CLI from the same checkout as the app so local changes are
not confused with managed release evidence.

Install the developer CLI manually:

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
bash scripts/install-development.sh --no-onboard
```

## Troubleshooting

### Build Fails: Toolchain or SDK Mismatch

The macOS app build expects the latest macOS SDK and Swift 6.2 toolchain.

**System dependencies (required):**

- **Latest macOS version available in Software Update** (required by Xcode 26.2
  SDKs)
- **Xcode 26.2** (Swift 6.2 toolchain)

**Checks:**

```bash
xcodebuild -version
xcrun swift --version
```

If versions don’t match, update macOS/Xcode and re-run the build.

### App Crashes on Permission Grant

If the app crashes when you try to allow **Speech Recognition** or
**Microphone** access, it may be due to a corrupted TCC cache or signature
mismatch.

**Fix:**

1. Reset the TCC permissions:

   ```bash
   tccutil reset All ai.fased.mac.debug
   ```

2. If that fails, change the `BUNDLE_ID` temporarily in
   [`scripts/package-mac-app.sh`](https://github.com/fased-ai/fased/blob/main/scripts/package-mac-app.sh)
   to force a clean slate from macOS.

### Gateway "Starting..." indefinitely

If the gateway status stays on "Starting...", check if a stale process is
holding the port:

```bash
fased gateway status
fased gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

If a manual run is holding the port, stop that process with Ctrl+C. As a last
resort, kill the PID you found above.
