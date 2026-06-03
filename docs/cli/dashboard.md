---
summary: "Open or print the Dashboard URL using your current gateway auth."
read_when:
  - You want to open the browser UI with your current token
  - You want to print the URL without launching a browser
title: "dashboard"
---

# `fased dashboard`

Open the browser UI with the current gateway auth context, or print the URL
without launching a browser.

The command opens the configured Control UI base URL with the current gateway
token in the URL fragment. The UI strips that token and exchanges it for a
Control UI session when possible. The compact Dashboard is available at `/dash`
inside that UI. Normal setup starts in **Agents** after you select an Agent.
Operator diagnostics live in **Logs**, **Usage**, and **Advanced** (`Config`,
`Debug`, `Nodes`).

The command also prints the URL and copies it to the clipboard when clipboard
access is available. With `--no-open`, it still prints/copies the URL but does
not launch a browser. When the Gateway is bound to LAN, the command opens the
local loopback URL for the browser because that is the safer same-machine
control path.

```bash
fased dashboard
fased dashboard --no-open
```

Related:

- [Dashboard](/web/dashboard)
- [Control UI layout](/web/control-ui)
- [Diagnostics](/diagnostics/index)
