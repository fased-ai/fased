---
summary: "Voice overlay lifecycle when wake-word and push-to-talk overlap"
read_when:
  - Adjusting voice overlay behavior
title: "Voice Overlay"
---

# Voice Overlay Lifecycle (macOS)

Audience: macOS app contributors. Goal: keep the voice overlay predictable when
wake-word and push-to-talk overlap.

## Current intent

- If the overlay is already visible from wake-word and the user presses the
  hotkey, the hotkey session adopts the existing text instead of resetting it.
  The overlay stays up while the hotkey is held. On release: send if there is
  trimmed text, otherwise dismiss.
- Wake-word alone still auto-sends on silence; push-to-talk sends immediately on release.

## Implemented (Dec 9, 2025)

- Overlay sessions now carry a token per capture. Partial/final/send/dismiss
  and level updates are dropped when the token does not match.
- Push-to-talk adopts any visible overlay text as a prefix. It waits up to 1.5s
  for a final transcript before falling back to the current text.
- Chime/overlay logging is emitted at `info` in categories `voicewake.overlay`,
  `voicewake.ptt`, and `voicewake.chime`.

## Current structure

- `VoiceSessionCoordinator` owns the active tokenized voice session and drops
  stale partial/final/send/dismiss callbacks.
- `VoiceWakeRuntime` handles wake-word capture, silence windows, hard stops, and
  restart after dismiss.
- `VoicePushToTalk` handles the right-Option/Cmd+Fn push-to-talk path and pauses
  wake-word capture while the hotkey session is active.
- `VoiceWakeOverlayController` renders the overlay and forwards user actions
  back through the active session token.
- Logs use subsystem `ai.fased` with categories including
  `voicewake.runtime`, `voicewake.coordinator`, `voicewake.overlay`,
  `voicewake.ptt`, `voicewake.forward`, and `voicewake.chime`.

## Debugging checklist

- Stream logs while reproducing a sticky overlay:

  ```bash
  sudo log stream \
    --predicate 'subsystem == "ai.fased" AND category CONTAINS "voicewake"' \
    --level info \
    --style compact
  ```

- Verify only one active session token; stale callbacks should be dropped by the
  coordinator.
- Ensure push-to-talk release always calls `endCapture` with the active token.
  If text is empty, expect `dismiss` without chime or send.
