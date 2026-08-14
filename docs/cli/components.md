---
summary: "Inspect bundled Fased components and runtimes that must run externally."
read_when:
  - You need to distinguish installed, configured, and ready components
  - You are checking bundled channels or external model runtimes
title: "components"
---

# `fased components`

Show one lifecycle report for bundled Fased capabilities and external runtimes:

```bash
fased components
fased components --json
```

The report uses these states:

| State               | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `included`          | The capability ships in Fased core.                            |
| `external-required` | Install or run the external runtime, then connect it to Fased. |
| `not-installed`     | Reserved for independently installed third-party components.   |
| `installed`         | Third-party runtime code is present but still needs setup.     |
| `configured`        | Fased has configuration; run the live check for readiness.     |
| `ready`             | The capability passed its live readiness check.                |
| `error`             | The installed capability failed to load or report state.       |

External runtimes are not Doctor errors. Fased-owned components ship in the
signed generation and remain disabled until selected.

The same report appears under **Services > Components** in the Control UI and
in the final onboarding and Doctor summaries.

See [Core And External Components](/install/components) for delivery paths.
