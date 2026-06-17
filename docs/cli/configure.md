---
summary: "Open the interactive configuration flow for models, channels, web/search, gateway mode, and defaults."
read_when:
  - You want to tweak credentials, devices, or agent defaults interactively
title: "configure"
---

# `fased configure`

Open the interactive configuration flow for credentials, channels, device
access, models, web/search services, and Agent defaults.

Browser equivalent: use **Agents** for normal setup. Pick an Agent, then use
Models, Channels, Skills, Tools, Memory, Sessions, Services, Tasks,
Coordination, and Files. Use **Advanced > Config** only as the raw escape hatch.

Note: the **Model** section configures provider credentials and model auth.
After providers are signed in, choose the selected Agent's primary, fallback,
and task-role models from **Agent > Models**.

Tip: `fased config` without a subcommand opens the same wizard. Use
`fased config get|set|unset` for non-interactive edits.

Related:

- Gateway configuration reference: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)
- Browser UI setup: [Control UI setup](/start/control-ui-setup)

Notes:

- Choosing where the Gateway runs always updates `gateway.mode`. You can select
  "Continue" without other sections if that is all you need.
- `--section web` opens the same Web/search provider flow used by
  Services. It can select available built-in or configured providers, store the
  provider key or base URL when needed, and enable `web_search`.
- The **Channels** section uses the same setup-first flow as **Agent >
  Channels**. Bundled channels prompt for credentials directly; external
  catalog channels install first, then expose credential fields after restart.

## Examples

```bash
fased configure
fased configure --section model --section channels
fased configure --section web
```
