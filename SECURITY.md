# Security Policy

This repository does not currently maintain a separate trust site or paid
bug-bounty program.

Use GitHub as the reporting surface.

## Where to report

Use the GitHub issue tracker for most security bugs, hardening issues, and threat
model corrections:

- https://github.com/fased-ai/agent/issues

If the report contains secret material, private infrastructure details, or
exploit steps that should not be posted publicly:

1. use GitHub private vulnerability reporting if it is enabled:
   https://github.com/fased-ai/agent/security/advisories/new
2. otherwise open a minimal GitHub issue without the sensitive details and ask
   for a private handoff
3. do not paste credentials, private keys, tokens, seed phrases, or live exploit
   data into public issues

## What to include

For the fastest triage, include:

- affected version or commit SHA
- affected file, function, or route if known
- reproduction steps
- practical impact
- configuration assumptions
- suggested fix or mitigation if you have one

Reports that only say “the model can be tricked” without a real boundary bypass
are not actionable.

## Current trust model

Fased is a self-hosted one-operator runtime by default.

Important boundaries:

- gateway auth callers are trusted operators for that runtime
- session ids are routing controls, not multi-tenant auth boundaries
- plugins are trusted code once installed
- workspace files and local config are trusted local state

If you need strong separation between users, run separate gateways and separate
OS users or hosts.

## Deployment guidance

Preferred posture:

- loopback-only gateway by default
- remote access through Tailscale, SSH tunneling, or another private access layer
- control pages protected by gateway token and device auth
- wallets, mining, bond, and trading features enabled only after the base runtime is stable

Do not treat a public reverse proxy as the default secure admin posture.

## Out of scope

The following are usually not security vulnerabilities by themselves:

- prompt injection without a real auth, sandbox, or policy bypass
- behavior from a plugin that a trusted operator intentionally installed
- issues that require direct write access to trusted local config or workspace files
- reports that assume one shared gateway is a hardened multi-tenant environment

## No bug bounty

There is no paid bug bounty program right now.

Responsible, technically grounded reports are still appreciated.
