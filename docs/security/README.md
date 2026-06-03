# Fased Security Docs

This folder holds threat-model and security reference material for the public repo.

## Start here

- [Security overview](/security)
- [Security policy](https://github.com/fased-ai/agent/blob/main/SECURITY.md)
- [Gateway security guide](/gateway/security)
- [Remote access](/gateway/remote)
- [Tailscale](/gateway/tailscale)
- [SecretRef matrix](/reference/secretref-matrix)
- [Wallet autonomous security](/plugins/crypto/wallet-autonomous-security)
- [Skills](/tools/skills)
- [Full release validation](/reference/full-release-validation)
- [Threat model](/security/THREAT-MODEL-ATLAS)
- [Contributing to the threat model](/security/CONTRIBUTING-THREAT-MODEL)
- [Formal verification](/security/formal-verification)

## Security model in the UI

- Agent setup is Agent-first: Models, Channels, Skills, Tools, Memory, Services, Tasks.
- Services connect credentials; Agent > Tools grants or blocks tool use.
- Skills can be installed/configured per Agent, but wallet use still requires Wallets > Skill Grants.
- Advanced contains Config, Debug, and Nodes for operator/admin diagnostics.
- Logs and Usage are diagnostic/accounting surfaces, not setup wizards.

## Reporting vulnerabilities

Use the repository security policy:

- open a GitHub issue for most reports
- do not post secrets, private infra details, or live exploit material
- if the report needs a private handoff, open a minimal issue and say so
