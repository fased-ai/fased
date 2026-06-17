---
summary: "Drive browser profiles, tabs, screenshots, and relay-backed browser control from the CLI."
read_when:
  - You use `fased browser` and want examples for common tasks
  - You want to control a browser running on another machine via a node host
  - You want to use the Chrome extension relay (attach/detach via toolbar button)
title: "browser"
---

# `fased browser`

Manage the Fased browser control server and run browser actions such as tabs,
snapshots, screenshots, navigation, clicks, and typing.

Related:

- Browser tool + API: [Browser tool](/tools/browser)
- Chrome extension relay: [Chrome extension](/tools/chrome-extension)

## Common flags

- `--url <gatewayWsUrl>`: Gateway WebSocket URL (defaults to config).
- `--token <token>`: Gateway token (if required).
- `--timeout <ms>`: request timeout (ms).
- `--browser-profile <name>`: choose a browser profile (default from config).
- `--json`: machine-readable output (where supported).

## Quick start (local)

```bash
fased browser --browser-profile chrome tabs
fased browser --browser-profile fased start
fased browser --browser-profile fased open https://example.com
fased browser --browser-profile fased snapshot
```

## Profiles

Profiles are named browser routing configs. In practice:

- `fased`: launches/attaches to a dedicated Fased-managed Chrome instance (isolated user data dir).
- `chrome`: controls your existing Chrome tab(s) via the Chrome extension relay.

```bash
fased browser profiles
fased browser create-profile --name work --color "#FF5A36"
fased browser delete-profile --name work
```

Use a specific profile:

```bash
fased browser --browser-profile work tabs
```

## Tabs

```bash
fased browser tabs
fased browser open https://docs.fased.ai
fased browser focus <targetId>
fased browser close <targetId>
```

## Snapshot / screenshot / actions

Snapshot:

```bash
fased browser snapshot
```

Screenshot:

```bash
fased browser screenshot
```

Navigate/click/type (ref-based UI automation):

```bash
fased browser navigate https://example.com
fased browser click <ref>
fased browser type <ref> "hello"
```

## Chrome extension relay (attach via toolbar button)

This mode lets the agent control an existing Chrome tab that you attach manually (it does not auto-attach).

Install the unpacked extension to a stable path:

```bash
fased browser extension install
fased browser extension path
```

Then Chrome → `chrome://extensions` → enable “Developer mode” →
“Load unpacked” → select the printed folder.

Full guide: [Chrome extension](/tools/chrome-extension)

## Remote browser control (node host proxy)

If the Gateway runs on a different machine than the browser, run a **node host**
on the machine that has Chrome/Brave/Edge/Chromium. The Gateway will proxy
browser actions to that node.

Use `gateway.nodes.browser.mode` to control auto-routing and
`gateway.nodes.browser.node` to pin a specific node if multiple are connected.

Security + remote setup: [Browser tool](/tools/browser),
[Remote access](/gateway/remote), [Tailscale](/gateway/tailscale),
[Security](/gateway/security)
