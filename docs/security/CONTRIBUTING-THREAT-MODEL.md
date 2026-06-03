---
title: "Contributing To The Threat Model"
summary: "How to propose threats, mitigations, attack chains, and corrections for the Fased security model."
sidebarTitle: "Threat contributions"
---

# Contributing to the Fased Threat Model

Thanks for helping make Fased more secure. This threat model is a living document and we welcome contributions from anyone - you don't need to be a security expert.

## Ways to Contribute

### Add a Threat

Spotted an attack vector or risk we haven't covered? Open an issue on
[fased-ai/agent](https://github.com/fased-ai/agent/issues) and
describe it in your own words. You don't need to know any frameworks or fill in
every field - just describe the scenario.

**Helpful to include (but not required):**

- The attack scenario and how it could be exploited
- Which parts of Fased are affected: Agent setup tabs, gateway, channels, services, skills/plugin catalog, dependency installers, Agent tool policy, wallets, SAT mining, Advanced diagnostics, nodes, MCP servers, CLI, etc.
- How severe you think it is (low / medium / high / critical)
- Any links to related research, CVEs, or real-world examples

We'll handle the ATLAS mapping, threat IDs, and risk assessment during review. If you want to include those details, great - but it's not expected.

> **This is for adding to the threat model, not reporting live vulnerabilities.**
> If you found an exploitable vulnerability, use [`SECURITY.md`](https://github.com/fased-ai/agent/blob/main/SECURITY.md).

### Suggest a Mitigation

Have an idea for how to address an existing threat? Open an issue or PR referencing the threat. Useful mitigations are specific and actionable - for example, "per-sender rate limiting of 10 messages/minute at the gateway" is better than "implement rate limiting."

For skills and wallets, specify which gate should change: install review, Agent skill allowlist, Agent tool policy, Wallet > Skill Grants, passkey approval, or mining wallet policy.

### Propose an Attack Chain

Attack chains show how multiple threats combine into a realistic attack scenario. If you see a dangerous combination, describe the steps and how an attacker would chain them together. A short narrative of how the attack unfolds in practice is more valuable than a formal template.

### Fix or Improve Existing Content

Typos, clarifications, outdated info, better examples - PRs welcome, no issue needed.

## What We Use

### MITRE ATLAS

This threat model is built on [MITRE ATLAS](https://atlas.mitre.org/) (Adversarial Threat Landscape for AI Systems), a framework designed specifically for AI/ML threats like prompt injection, tool misuse, and agent exploitation. You don't need to know ATLAS to contribute - we map submissions to the framework during review.

### Threat IDs

Each threat gets an ID like `T-EXEC-003`. The categories are:

| Code    | Category                                   |
| ------- | ------------------------------------------ |
| RECON   | Reconnaissance - information gathering     |
| ACCESS  | Initial access - gaining entry             |
| EXEC    | Execution - running malicious actions      |
| PERSIST | Persistence - maintaining access           |
| EVADE   | Defense evasion - avoiding detection       |
| DISC    | Discovery - learning about the environment |
| EXFIL   | Exfiltration - stealing data               |
| IMPACT  | Impact - damage or disruption              |

IDs are assigned by maintainers during review. You don't need to pick one.

### Risk Levels

| Level        | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| **Critical** | Full system compromise, or high likelihood + critical impact      |
| **High**     | Significant damage likely, or medium likelihood + critical impact |
| **Medium**   | Moderate risk, or low likelihood + high impact                    |
| **Low**      | Unlikely and limited impact                                       |

If you're unsure about the risk level, just describe the impact and we'll assess it.

## Review Process

1. **Triage** - We review new submissions within 48 hours
2. **Assessment** - We verify feasibility, assign ATLAS mapping and threat ID, validate risk level
3. **Documentation** - We ensure everything is formatted and complete
4. **Merge** - Added to the threat model and visualization

## Resources

- [ATLAS Website](https://atlas.mitre.org/)
- [ATLAS Techniques](https://atlas.mitre.org/techniques/)
- [ATLAS Case Studies](https://atlas.mitre.org/studies/)
- [Fased Threat Model](/security/THREAT-MODEL-ATLAS)

## Contact

- **Security vulnerabilities:** use [`SECURITY.md`](https://github.com/fased-ai/agent/blob/main/SECURITY.md)
- **Threat model questions:** open an issue on [fased-ai/agent](https://github.com/fased-ai/agent/issues)
- **General discussion:** use the normal repo issue/discussion flow

## Recognition

Contributors to the threat model are recognized through git history, issue and PR history, and release notes when that context helps users understand a change.
