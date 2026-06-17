---
summary: "Security model and hardening guide for the self-hosted Fased Gateway."
read_when:
  - Adding features that widen access or automation
  - Exposing a Gateway beyond loopback
  - Reviewing tool, channel, node, browser, or plugin authority
title: "Security"
---

# Security

> [!WARNING]
> Fased assumes one trusted operator boundary per Gateway. It is not a hostile
> multi-tenant boundary for adversarial users sharing the same Gateway, host,
> credentials, or Agent.

Use this page to decide who can reach the Gateway, who can message an Agent,
what tools an Agent can use, and what to do if something goes wrong.

## Trust Model

Recommended deployment model:

- one user or trusted team boundary per Gateway;
- one OS user/host/VPS per trust boundary when possible;
- separate credentials, workspaces, and browser profiles for separate trust
  boundaries;
- split mixed-trust users into separate Gateways.

Inside one Gateway, authenticated operator access is control-plane access.
Session keys are routing/context selectors, not authorization tokens. Per-user
session isolation helps privacy, but it does not turn one shared Gateway into a
hostile multi-tenant platform.

## Quick Audit

Run this after setup changes and before exposing the Gateway:

```bash
fased security audit
fased security audit --deep
fased security audit --fix
fased security audit --json
```

The audit checks common footguns:

- Gateway bind/auth exposure;
- DM and group policies;
- broad tool or elevated-tool access;
- browser/node exposure;
- weak local file permissions;
- plugin loading without explicit allowlists;
- risky debug flags;
- sandbox settings that look configured but are not active.

## Recommended Baseline

Start private, then widen deliberately:

```json5
{
  gateway: {
    mode: "local",
    bind: "loopback",
    auth: { mode: "token", token: "replace-with-long-random-token" },
  },
  session: {
    dmScope: "per-channel-peer",
  },
  tools: {
    profile: "messaging",
    deny: ["group:automation", "group:runtime", "group:fs", "sessions_spawn", "sessions_send"],
    fs: { workspaceOnly: true },
    exec: { security: "deny", ask: "always" },
    elevated: { enabled: false },
  },
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

This keeps the Gateway local, requires DM pairing, isolates DM sessions, and
keeps control-plane/runtime tools out of normal chat paths.

## Network Exposure

Gateway auth is required for any non-trivial deployment.

Recommended exposure order:

1. `gateway.bind: "loopback"` with token auth.
2. Tailscale Serve, a direct tailnet path, or SSH tunnel.
3. Trusted reverse proxy with explicit `gateway.trustedProxies`.
4. LAN/custom bind only when intentional, authenticated, and firewalled.

Avoid:

- unauthenticated `0.0.0.0`;
- public port forwarding to the raw Gateway;
- forwarding Tailscale identity headers from a custom proxy;
- relying on `sessionKey` as an auth boundary.

For proxy deployments:

- set `gateway.trustedProxies`;
- make the proxy overwrite forwarding headers;
- use token/password or trusted-proxy auth;
- set `gateway.controlUi.allowedOrigins` when browser `Origin` differs from
  the Gateway origin.

See [Trusted Proxy Auth](/gateway/trusted-proxy-auth),
[Tailscale](/gateway/tailscale), and [Remote Gateway](/gateway/remote).

## Control UI Auth

The Control UI needs a secure browser context: HTTPS or localhost.

Important settings:

- `gateway.auth.mode: "token"`: shared bearer token.
- `gateway.auth.mode: "password"`: password auth, preferably from env.
- `gateway.auth.mode: "trusted-proxy"`: trust an identity-aware proxy.
- `gateway.controlUi.allowInsecureAuth`: local compatibility switch only.
- `gateway.controlUi.dangerouslyDisableDeviceAuth`: break-glass only.

`allowInsecureAuth` is not a remote-auth bypass. Remote clients still need the
right Gateway auth/device flow. `dangerouslyDisableDeviceAuth` is a severe
downgrade and should be temporary.

## DM And Group Access

DM policies:

| Policy      | Meaning                                             |
| ----------- | --------------------------------------------------- |
| `pairing`   | Unknown sender gets a pairing code; owner approves. |
| `allowlist` | Only configured/approved senders can message.       |
| `open`      | Anyone can DM; requires explicit `"*"` opt-in.      |
| `disabled`  | Ignore inbound DMs.                                 |

Group policy should normally be allowlist plus mention gating. Public or
multi-person rooms should not have broad tools.

If more than one person can DM an Agent, set:

```json5
{
  session: { dmScope: "per-channel-peer" },
}
```

For multiple accounts on the same channel, use `per-account-channel-peer`.

## Tool Authority

Most incidents come from a reachable Agent being allowed to use tools that are
too broad for that audience.

High-impact surfaces:

- `exec` / `process`;
- filesystem read/write/edit/apply_patch;
- browser control;
- `gateway` config/update calls;
- `cron`/task creation from untrusted paths;
- session tools that can inspect or message other sessions;
- node commands such as camera, screen, contacts, calendar, SMS, or shell.

For any Agent that reads untrusted content, start with:

```json5
{
  tools: {
    deny: ["gateway", "cron", "sessions_spawn", "sessions_send", "exec", "process"],
    fs: { workspaceOnly: true },
  },
}
```

Use per-Agent tool profiles for different roles. See
[Sandboxing](/gateway/sandboxing) and
[Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated).

## Sandboxing

Sandboxing is a tool-execution boundary, not a replacement for channel access
control.

Options:

- run the whole Gateway in Docker;
- run host Gateway with Docker-isolated tools through `agents.defaults.sandbox`;
- keep `workspaceAccess: "none"` or `"ro"` for agents that do not need write
  access;
- keep `scope: "agent"` or `"session"` for isolation.

Important: if sandbox mode is off, `exec` runs on the Gateway host unless your
tool policy denies it or exec approval blocks it.

## Browser And Node Control

Browser control can act through the selected browser profile. If that profile is
signed in to services, the Agent may be able to interact with them.

Recommended pattern:

- use a dedicated browser profile for Fased;
- avoid personal daily-driver profiles;
- keep browser/node hosts on tailnet-only access;
- disable browser proxy routing when not needed;
- pair nodes deliberately and treat node pairing as operator-level access.

Chrome extension relay mode can control existing Chrome tabs. Use it only when
that is intentional.

## Prompt Injection

Prompt injection is not solved by system prompts. Treat untrusted messages,
links, files, emails, pages, and attachments as adversarial input.

Hard controls matter more than wording:

- pairing/allowlists;
- group mention gates;
- minimal tools;
- sandboxing;
- restricted file roots;
- modern instruction-following models for tool-enabled Agents;
- dedicated summarizer Agents for untrusted content before passing summaries to
  a higher-authority Agent.

Keep external-content bypass flags off unless you are debugging a tightly scoped
case:

- `hooks.mappings[].allowUnsafeExternalContent`
- `hooks.gmail.allowUnsafeExternalContent`
- cron payload field `allowUnsafeExternalContent`

## Secrets, Logs, And Transcripts

Treat these as private:

- `~/.fased/fased.json`
- `~/.fased/credentials/**`
- `~/.fased/agents/<agentId>/agent/auth-profiles.json`
- `~/.fased/secrets.json`
- `~/.fased/agents/<agentId>/sessions/**`
- `~/.fased/extensions/**`
- `~/.fased/sandboxes/**`

Hardening:

- use `700` on directories and `600` on private files;
- use full-disk encryption where practical;
- keep `logging.redactSensitive` enabled;
- add environment-specific redaction patterns;
- prune old logs/transcripts when no longer needed;
- review diagnostics before sharing.

## Plugins And Dynamic Skills

Plugins and dynamic skills are trusted code.

- Install from sources you trust.
- Prefer explicit `plugins.allow`.
- Review plugin config before enabling.
- Pin package versions when installing from registries.
- Restart the Gateway after plugin changes.
- Restrict who can modify skill folders.

## Incident Response

If the Agent did something unexpected:

1. Stop the Gateway or app supervisor.
2. Close exposure: return `gateway.bind` to `loopback` and disable public access.
3. Freeze risky channels: use `dmPolicy: "disabled"` or stricter allowlists.
4. Rotate Gateway auth and remote client credentials.
5. Rotate provider/channel/model credentials if they may have leaked.
6. Review logs, session transcripts, and recent config changes.
7. Run `fased security audit --deep`.

Collect for a report:

- timestamp and Fased version;
- OS/host shape;
- redacted transcript and log excerpt;
- exact inbound message/content;
- whether the Gateway was exposed beyond loopback.

## Security Reports

Use the repository security policy:

- [`SECURITY.md`](https://github.com/fased-ai/fased/blob/main/SECURITY.md)

Do not post secrets, private infrastructure details, or live exploit material in
public issues.

## Related

- [Authentication](/gateway/authentication)
- [Trusted Proxy Auth](/gateway/trusted-proxy-auth)
- [Sandboxing](/gateway/sandboxing)
- [Session Management](/concepts/session)
- [Logging](/gateway/logging)
- [Secrets](/gateway/secrets)
