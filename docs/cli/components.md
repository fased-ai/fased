---
summary: "Inspect what Fased includes, what is installed as an add-on, and what must run externally."
read_when:
  - You need to distinguish installed, configured, and ready components
  - You are checking optional channels or external model runtimes
title: "components"
---

# `fased components`

Show one lifecycle report for core capabilities, npm add-ons, and external
runtimes:

```bash
fased components
fased components --json
```

The report uses these states:

| State               | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `included`          | The capability ships in Fased core.                            |
| `external-required` | Install or run the external runtime, then connect it to Fased. |
| `not-installed`     | The optional npm add-on has not been installed.                |
| `installed`         | Runtime code is present but still needs setup or restart.      |
| `configured`        | Fased has configuration; run the live check for readiness.     |
| `ready`             | The capability passed its live readiness check.                |
| `error`             | The installed capability failed to load or report state.       |

Missing optional add-ons and external runtimes are not Doctor errors. Install
only what the Agent uses.

The same report appears under **Services > Components** in the Control UI and
in the final onboarding and Doctor summaries.

See [Core And Optional Components](/install/components) for installation paths.
