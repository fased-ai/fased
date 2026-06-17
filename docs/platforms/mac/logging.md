---
summary: "Fased macOS logging: rolling diagnostics file log and unified log privacy flags"
read_when:
  - Capturing macOS logs or investigating private data logging
  - Debugging voice wake/session lifecycle issues
title: "macOS Logging"
---

# Logging (macOS)

## Rolling diagnostics file log (Debug pane)

The macOS app routes logs through swift-log, using unified logging by default.
It can also write a local, rotating file log when you need a durable capture.

- Verbosity: **Debug pane → Logs → App logging → Verbosity**
- Enable: **Debug pane → Logs → App logging → “Write rolling diagnostics log (JSONL)”**
- Location: `~/Library/Logs/FasedAgent/diagnostics.jsonl`. It rotates
  automatically; old files are suffixed with `.1`, `.2`, and so on.
- Clear: **Debug pane → Logs → App logging → “Clear”**

Notes:

- This is **off by default**. Enable only while actively debugging.
- Treat the file as sensitive; don’t share it without review.

## Unified logging private data on macOS

Unified logging redacts most payloads unless a subsystem opts into
`privacy -off`. This is controlled by a plist in
`/Library/Preferences/Logging/Subsystems/` keyed by subsystem name. Only new log
entries pick up the flag, so enable it before reproducing an issue.

## Enable for the macOS app (`ai.fased`)

- Write the plist to a temp file first, then install it atomically as root:

```bash
cat <<'EOF' >/tmp/ai.fased.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/ai.fased.plist /Library/Preferences/Logging/Subsystems/ai.fased.plist
```

- No reboot is required; `logd` notices the file quickly, but only new log lines
  include private payloads.
- View richer macOS unified-log output with `log show` or `log stream` filtered
  to subsystem `ai.fased`.

## Disable after debugging

- Remove the override: `sudo rm /Library/Preferences/Logging/Subsystems/ai.fased.plist`.
- Optionally run `sudo log config --reload` to force `logd` to drop the override
  immediately.
- This surface can include phone numbers and message bodies. Keep the plist in
  place only while you actively need the extra detail.
