---
summary: "Zalo Personal plugin: QR login + messaging via zca-cli (bundled extension + channel config + CLI + tool)"
read_when:
  - You want Zalo Personal (unofficial) support in Fased
  - You are configuring or developing the zalouser plugin
title: "Zalo Personal Plugin"
---

# Zalo Personal (plugin)

Zalo Personal support for Fased via a plugin, using `zca-cli` to automate a normal Zalo user account.

> **Warning:** Unofficial automation may lead to account suspension/ban. Use at your own risk.

## Naming

Channel id is `zalouser` to make it explicit this automates a **personal Zalo user account** (unofficial). We keep `zalo` reserved for a potential future official Zalo API integration.

## Where it runs

This plugin runs **inside the Gateway process**.

If you use a remote Gateway, install/configure it on the **machine running the Gateway**, then restart the Gateway.

## Normal setup

Zalo Personal is bundled in the repo as `extensions/zalouser`.

For normal users:

1. open **Agents**
2. select the Agent
3. open **Channels**
4. choose **Zalo Personal**
5. enable it, scan the QR login, and configure DM/group access

This enables the local bundled extension and then uses `channels.zalouser` for
account credentials and routing. If the Gateway is remote, the QR login and
`zca` dependency still run on the Gateway machine.

## Developer or external install

Use this only when testing the packaged extension outside the bundled repo copy.

```bash
fased plugins install @fased/zalouser
```

Restart the Gateway afterwards.

For local extension development:

```bash
fased plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

Restart the Gateway afterwards.

## Prerequisite: zca-cli

The Gateway machine must have `zca` on `PATH`:

```bash
zca --version
```

## Config

Channel config lives under `channels.zalouser` (not `plugins.entries.*`):

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## CLI

```bash
fased channels login --channel zalouser
fased channels logout --channel zalouser
fased channels status --probe
fased message send --channel zalouser --target <threadId> --message "Hello from Fased"
fased directory peers list --channel zalouser --query "name"
```

## Agent tool

Tool name: `zalouser`

Actions: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
