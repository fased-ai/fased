---
summary: "How the mac app embeds the gateway Chat view and how to debug it"
read_when:
  - Debugging mac Chat view or loopback port
title: "Chat View"
---

# Chat View (macOS app)

The macOS menu bar app embeds the gateway Chat UI as a native SwiftUI view. It
connects to the Gateway and defaults to the **main session** for the selected
agent (with a session switcher for other sessions).

- **Local mode**: connects directly to the local Gateway WebSocket.
- **Remote mode**: forwards the Gateway control port over SSH and uses that
  tunnel as the data plane.

## Launch & debugging

- Manual: Fased menu → “Open Chat”.
- Auto‑open for testing:

  ```bash
  dist/FasedAgent.app/Contents/MacOS/FasedAgent --webchat
  ```

- Gateway logs: `fased logs --follow`.
- macOS app unified logs: filter subsystem `ai.fased` and category
  `WebChatSwiftUI` with `log stream` or `log show`.

## How it’s wired

- Data plane: Gateway WS methods `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` and events `chat`, `agent`, `presence`, `tick`, `health`.
- Session: defaults to the selected Agent’s main session (`main`, or `global`
  when scope is global). The UI can switch between sessions.
- Onboarding uses a dedicated session to keep first‑run setup separate.

## Security surface

- Remote mode forwards only the Gateway WebSocket control port over SSH.

## Known limitations

- The UI is optimized for chat sessions (not a full browser sandbox).
