---
summary: "Manual logins for browser automation on strict sites"
read_when:
  - You need to log into sites for browser automation
  - A site blocks automated login or requires human verification
title: "Browser Login"
---

# Browser login

## Manual login (recommended)

When a site requires login, **sign in manually** in the **host** browser profile (the fased browser).

Do **not** give the model your credentials. Automated logins often trigger anti‑bot defenses and can lock the account.

Back to the main browser docs: [Browser](/tools/browser).

## Which Chrome profile is used?

Fased controls a **dedicated Chrome profile** (named `fased`, orange‑tinted UI). This is separate from your daily browser profile.

Two easy ways to access it:

1. **Ask the agent to open the browser** and then log in yourself.
2. **Open it via CLI**:

```bash
fased browser start
fased browser open https://x.com
```

If you have multiple profiles, pass `--browser-profile <name>` (the default is `fased`).

## Strict-site recommended flow

- Use the **host** browser with manual login.
- Let the agent inspect and operate only after you intentionally open the logged-in session.
- Keep high-impact actions reviewed by the operator.

## Sandboxing + host browser access

Sandboxed browser sessions are **more likely** to trigger bot detection. For strict sites, prefer the **host** browser.

If the agent is sandboxed, the browser tool defaults to the sandbox. To allow host control:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Then target the host browser:

```bash
fased browser open https://x.com --browser-profile fased --target host
```

Or disable sandboxing for the agent that posts updates.
