---
title: "Security Overview"
summary: "Security-first setup guide for remote access, credentials, skills, wallet grants, and admin surfaces."
read_when:
  - Preparing a public or hosted Fased install
  - Reviewing skill, wallet, service credential, or remote access risk
  - Explaining which UI surfaces are for normal setup versus admin diagnostics
---

# Security Overview

Fased is an agent you run with a local Gateway. Treat it like a local server
with access to chats, tools, credentials, files, wallets, and optional paired
devices.

The conservative setup keeps each capability behind a separate gate: connect the
service, allow the Agent to use the tool, then approve sensitive actions when
needed.

## Normal Setup Surfaces

Use the selected Agent first:

- **Agent > Models**: connect provider auth and choose this Agent's primary, fallback, and task models.
- **Agent > Channels**: configure chat apps and route messages to this Agent.
- **Agent > Services**: connect API services such as web search, GitHub, Gmail, media, and custom APIs.
- **Agent > Skills**: review/install skills, configure values, install
  dependencies, test loading, and allow the skill for this Agent.
- **Agent > Tools**: grant or block this Agent from using tools that already exist.
- **Agent > Memory**: inspect saved context, session-memory status, and roots for this Agent.
- **Agent > Tasks**: schedule work that runs as this Agent.

Admin and monitoring surfaces are separate:

- **Usage**: local token and cost history.
- **Logs**: gateway log tail.
- **Advanced**: Config, Debug, and Nodes tabs for raw settings and diagnostics.

## Remote Access

Preferred modes:

- Local-only: bind to loopback and open `http://localhost:18789`.
- Private remote: use Tailscale or an SSH tunnel.
- Public hosting: require gateway auth, TLS in front of the gateway, and firewall rules that expose only the intended port.

Avoid binding the gateway to a public interface without auth. If you need remote
browser access, keep Token or Password auth enabled and use Tailscale/private
networking where possible.

Related docs:

- [Security Test Report](/security/security-test-report)
- [Threat Model Atlas](/security/THREAT-MODEL-ATLAS)
- [Formal Verification](/security/formal-verification)
- [Gateway security](/gateway/security)
- [Remote Access](/gateway/remote)
- [Tailscale](/gateway/tailscale)
- [SecretRef Matrix](/reference/secretref-matrix)
- [Install](/install)

## Service Credentials

Service credentials connect an API. They do not automatically grant every Agent access.

Use:

- **Agent > Services** for normal service setup and tests.
- Environment-backed secret refs when you do not want keys stored directly in config.
- **Agent > Tools** to decide whether the selected Agent can use the resulting tool.

Avoid pasting secrets into chat, workspace files, skill instructions, or
screenshots. Advanced Config is the raw escape hatch for fields that do not yet
have a friendly page.

## Skills And Plugin Discovery

A skill is a `SKILL.md` instruction package plus optional configuration and
dependencies. Installing a skill means Fased has the skill file in the library
or workspace. It does not mean the dependency binary, API key, wallet access, or
Agent access is ready.

Conservative flow:

1. Review the source: bundled, workspace, or plugin catalog.
2. Install or copy the skill file.
3. Configure skill values in Agent > Skills.
4. Install dependencies only after reviewing the package manager, exact command,
   pin/integrity state, and PATH target.
5. Verify dependency health after install. Command success is not enough if the
   binary is not visible to the gateway.
6. Allow the skill for the selected Agent.
7. Grant tools or wallets separately when needed.

Plugin review should happen before files are written or made available. Review
archive layout, `SKILL.md`, requested permissions, dependency installers,
suspicious files, and update-risk changes.

Skills can be malicious even when they are only text instructions, because they
can steer the Agent toward dangerous tool use.

Related docs:

- [Security Test Report](/security/security-test-report)
- [Skills](/tools/skills)
- [Skills Config](/tools/skills-config)
- [Wallet roles and policies](/plugins/crypto/wallet-roles-and-policies)
- [API Usage and Costs](/reference/api-usage-costs)

## Wallets, Mining, And Skill Grants

Wallet access is intentionally separate from skills and tools.

- Wallet setup and approvals live in **Wallets**.
- Generic wallet-capable skills can only use Agent-role wallets that you explicitly allow.
- Mining and vault wallets are not available to generic skills.
- SAT mining uses the dedicated mining path and Mining wallet controls.
- A skill install, plugin review, or Agent skill allowlist change does not grant wallet access.

For wallet-capable skills, use **Wallets > Skill Grants** after review. Grant
only the actions, wallet ids, chains, caps, and automation level required for
the workflow.

Fased's default custody path is a role-separated self-hosted signer:

- `fased-signerd` owns signer-side material and signing operations.
- the Gateway owns controls, approvals, Agent routing, and audit state.
- skills and plugins request wallet work through wallet-control tools instead
  of receiving raw keys, seed phrases, keystores, or signer master credentials.

This is different from a generic hosted wallet provider. Hosted or MPC providers
can be useful optional adapters, especially for managed recovery, but they move
custody, recovery, provider credentials, and some control semantics outside the
local signer boundary. If you use one, keep Fased role controls, Agent tool
controls, Wallet > Skill Grants, approval state, and audit as the controlling
layer above it.

Related docs:

- [Wallets](/plugins/crypto/wallet-page)
- [Self-hosted wallet signer](/plugins/crypto/wallet-self-hosted)
- [Wallet Autonomous Security](/plugins/crypto/wallet-autonomous-security)
- [SAT Mining](/plugins/crypto/mining-page)

## Public Launch Checklist

- Gateway auth enabled for any non-loopback access.
- Remote access uses Tailscale, SSH tunnel, or a locked-down reverse proxy.
- Agent models, chat apps, services, skills, tools, saved context, and tasks configured per Agent.
- Skills reviewed before install; dependency installers reviewed and verified after install.
- Wallet skill grants are narrow and separate from mining/vault roles.
- Logs and Usage reviewed after setup smoke tests.
- Threat model and security-test-report claims reviewed for the current release.
- Advanced > Debug and Advanced > Nodes treated as admin diagnostics, not first-run setup.
- Run the public launch checks in [Full release validation](/reference/full-release-validation).

## Reporting Vulnerabilities

Use the repository security policy:

- [SECURITY.md](https://github.com/fased-ai/fased/blob/main/SECURITY.md)

Do not post secrets, private infrastructure details, or live exploit material in public issues.
