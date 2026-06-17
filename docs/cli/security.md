---
summary: "Audit the runtime for common security footguns and optionally apply conservative fixes."
read_when:
  - You want to run a quick security audit on config/state
  - You want to apply conservative fix suggestions (chmod, tighten defaults)
title: "security"
---

# `fased security`

Security tools for auditing the runtime and applying a narrow set of
deterministic fixes.

Related:

- Security guide: [Security](/gateway/security)

## Audit

```bash
fased security audit
fased security audit --deep
fased security audit --fix
fased security audit --json
```

The audit reports the main places where runtime security can drift:

- Shared DM inboxes: recommends secure DM mode
  `session.dmScope="per-channel-peer"` or
  `per-account-channel-peer` for multi-account channels.
- Shared-user ingress: emits `security.trust_model.multi_user_heuristic` when
  open DM/group policy, group targets, or wildcard sender rules suggest that
  several people may be sharing one runtime.
- Shared-user hardening: recommends sandboxed sessions, workspace-scoped file
  access, and keeping personal identities or credentials off shared runtimes.
- Model/tool risk: warns when small models (`<=300B`) can use web/browser tools
  without sandboxing.
- Webhook ingress: checks `hooks.defaultSessionKey`, request `sessionKey`
  overrides, and `hooks.allowedSessionKeyPrefixes`.
- Sandbox drift: checks Docker settings while sandbox mode is off, unsafe Docker
  network modes, and browser containers with missing or stale config hash labels.
- Node command policy: reports ineffective `gateway.nodes.denyCommands`
  patterns and dangerous entries in `gateway.nodes.allowCommands`.
- Tool policy: reports global `tools.profile="minimal"` overrides, open groups
  with runtime/filesystem tools, and extension plugin tools reachable under a
  permissive policy.
- Network exposure: flags `gateway.allowRealIpFallback=true`,
  `discovery.mdns.mode="full"`, and browser Docker `bridge` mode without
  `sandbox.browser.cdpSourceRange`.
- Supply-chain records: warns when npm-based plugin or hook install records are
  unpinned, missing integrity metadata, or drift from installed package versions.
- Channel allowlists: warns when allowlists rely on mutable names, emails, or
  tags instead of stable IDs.
- Gateway auth: warns when `gateway.auth.mode="none"` leaves HTTP APIs reachable
  without a shared secret.

Settings prefixed with `dangerous` or `dangerously` are explicit break-glass
operator overrides. Enabling one is not, by itself, a vulnerability report.
For the complete dangerous-parameter inventory, see the
"Insecure or dangerous flags summary" section in [Security](/gateway/security).

## JSON output

Use `--json` for CI/policy checks:

```bash
fased security audit --json | jq '.summary'
fased security audit --deep --json | jq '.findings[] | select(.severity=="critical") | .checkId'
```

If `--fix` and `--json` are combined, output includes both fix actions and final report:

```bash
fased security audit --fix --json | jq '{fix: .fix.ok, summary: .report.summary}'
```

## What `--fix` changes

`--fix` applies conservative, deterministic remediations:

- flips common `groupPolicy="open"` to `groupPolicy="allowlist"` (including account variants in supported channels)
- sets `logging.redactSensitive` from `"off"` to `"tools"`
- tightens permissions for state/config and common sensitive files such as
  `credentials/*.json`, `auth-profiles.json`, `sessions.json`, and session
  `*.jsonl`

`--fix` does **not**:

- rotate tokens/passwords/API keys
- disable tools (`gateway`, `cron`, `exec`, etc.)
- change gateway bind/auth/network exposure choices
- remove or rewrite plugins/skills
