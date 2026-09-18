---
title: "Troubleshooting"
summary: "Check the failing connection before changing everything."
---

## Cannot open the control panel

Run `fased health` on the machine running your instance. Use `fased dashboard` to open the control panel. For hosted installations, use the private connection described in [VPS Hosting](/install/vps).

## Chat does not respond

Check the selected model and provider credentials, then look at Logs. Confirm the provider account has access and any required balance. Try one short message before adding tools or automation.

## A tool fails

Check that tool's permissions and service connection. Retry a small read-only task. Do not grant broader access just to make an error disappear.

## A wallet action is unclear

Check its transaction status and balances before resubmitting. Keep keys and recovery phrases private. Follow [wallet setup](/plugins/crypto/wallet-page) for your installed release.

## Still stuck

Use the [detailed troubleshooting guide](/help/troubleshooting). When reporting a problem on [GitHub](https://github.com/fased-ai/fased/issues), include the installed version, relevant error and steps to reproduce. Remove credentials and private data from logs.
