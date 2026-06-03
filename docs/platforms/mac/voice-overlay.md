---
summary: "Voice overlay lifecycle when wake-word and push-to-talk overlap"
read_when:
  - Adjusting voice overlay behavior
title: "Voice Overlay"
---

# Voice Overlay Lifecycle (macOS)

Audience: macOS app contributors. Goal: keep the voice overlay predictable when wake-word and push-to-talk overlap.

## Current intent

- If the overlay is already visible from wake-word and the user presses the hotkey, the hotkey session _adopts_ the existing text instead of resetting it. The overlay stays up while the hotkey is held. When the user releases: send if there is trimmed text, otherwise dismiss.
- Wake-word alone still auto-sends on silence; push-to-talk sends immediately on release.

## Implemented (Dec 9, 2025)

- Overlay sessions now carry a token per capture (wake-word or push-to-talk). Partial/final/send/dismiss/level updates are dropped when the token doesn’t match, avoiding stale callbacks.
- Push-to-talk adopts any visible overlay text as a prefix (so pressing the hotkey while the wake overlay is up keeps the text and appends new speech). It waits up to 1.5s for a final transcript before falling back to the current text.
- Chime/overlay logging is emitted at `info` in categories `voicewake.overlay`, `voicewake.ptt`, and `voicewake.chime` (session start, partial, final, send, dismiss, chime reason).

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
  sudo log stream --predicate 'subsystem == "ai.fased" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- Verify only one active session token; stale callbacks should be dropped by the coordinator.
- Ensure push-to-talk release always calls `endCapture` with the active token; if text is empty, expect `dismiss` without chime or send.
