---
summary: "Generate pairing QR codes and setup codes for mobile clients."
read_when:
  - You want to pair the iOS app with a gateway quickly
  - You need setup-code output for remote/manual sharing
title: "qr"
---

# `fased qr`

Generate a pairing QR and setup code from the current gateway configuration.
This is mainly used for iOS or other remote setup flows that consume the same
gateway URL and auth payload.

## Usage

```bash
fased qr
fased qr --setup-code-only
fased qr --json
fased qr --remote
fased qr --url wss://gateway.example/ws --token '<token>'
```

## Options

- `--remote`: use `gateway.remote.url` plus remote token/password from config
- `--url <url>`: override gateway URL used in payload
- `--public-url <url>`: override public URL used in payload
- `--token <token>`: override gateway token for payload
- `--password <password>`: override gateway password for payload
- `--setup-code-only`: print only setup code
- `--no-ascii`: skip ASCII QR rendering
- `--json`: emit JSON (`setupCode`, `gatewayUrl`, `auth`, `urlSource`)

## Notes

- `--token` and `--password` are mutually exclusive.
- After scanning, approve device pairing with:
  - `fased devices list`
  - `fased devices approve <requestId>`
