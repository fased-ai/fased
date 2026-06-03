---
summary: "Search the published Fased docs index from the terminal."
read_when:
  - You want to search the live Fased docs from the terminal
title: "docs"
---

# `fased docs`

Search the live Fased docs index from the terminal when you need a quick lookup without opening the site manually.

```bash
fased docs
fased docs browser extension
fased docs sandbox allowHostControl
```

With no query, the command prints the docs URL and an example search command.
With a query, it calls the published docs search endpoint. The CLI uses
`mcporter` when it is installed, otherwise it runs the tool through `pnpm dlx` or
`npx`.
