---
summary: "Inspect and approve pairing requests for DM-capable channels."
read_when:
  - You’re using pairing-mode DMs and need to approve senders
title: "pairing"
---

# `fased pairing`

Approve or inspect DM pairing requests for channels that support pairing-mode access control.

Related:

- Pairing flow: [Pairing](/channels/pairing)

## Commands

```bash
fased pairing list telegram
fased pairing list --channel telegram --account work
fased pairing list telegram --json

fased pairing approve telegram <code>
fased pairing approve --channel telegram --account work <code> --notify
```

## Notes

- Channel input: pass it positionally (`pairing list telegram`) or with `--channel <channel>`.
- `pairing list` supports `--account <accountId>` for multi-account channels.
- `pairing approve` supports `--account <accountId>` and `--notify`.
- If only one pairing-capable channel is configured, `pairing approve <code>` is allowed.
- Extension channel ids are accepted when they match the channel-id format and
  advertise pairing support.
