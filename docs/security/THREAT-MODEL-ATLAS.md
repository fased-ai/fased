---
title: "Threat Model Atlas"
summary: "MITRE ATLAS-style threat model for Fased Agent, gateway, skills, wallets, tools, and public operator surfaces."
sidebarTitle: "Threat model"
---

# Fased Threat Model v1.0

## MITRE ATLAS Framework

**Version:** 1.0-draft
**Last Updated:** 2026-05-20
**Methodology:** MITRE ATLAS + Data Flow Diagrams
**Framework:** [MITRE ATLAS](https://atlas.mitre.org/) (Adversarial Threat Landscape for AI Systems)

### Framework Attribution

This threat model is built on [MITRE ATLAS](https://atlas.mitre.org/), the
industry-standard framework for documenting adversarial threats to AI/ML
systems. ATLAS is maintained by [MITRE](https://www.mitre.org/) in collaboration
with the AI security community.

**Key ATLAS Resources:**

- [ATLAS Techniques](https://atlas.mitre.org/techniques/)
- [ATLAS Tactics](https://atlas.mitre.org/tactics/)
- [ATLAS Case Studies](https://atlas.mitre.org/studies/)
- [ATLAS GitHub](https://github.com/mitre-atlas/atlas-data)
- [Contributing to ATLAS](https://atlas.mitre.org/resources/contribute)

### Contributing to This Threat Model

This is a living document maintained by the Fased contributor community. See
[Contributing to the threat model](/security/CONTRIBUTING-THREAT-MODEL) for
guidelines on contributing:

- Reporting new threats
- Updating existing threats
- Proposing attack chains
- Suggesting mitigations

---

## 1. Introduction

### 1.1 Purpose

This threat model documents adversarial threats to the Fased agent/runtime
platform and plugin catalog, using the MITRE ATLAS framework designed
specifically for AI/ML systems.

### 1.2 Scope

| Component            | Included | Notes                                                         |
| -------------------- | -------- | ------------------------------------------------------------- |
| Fased Runtime        | Yes      | Core agent execution, tool calls, sessions                    |
| Gateway              | Yes      | Authentication, routing, channel integration                  |
| Channel Integrations | Yes      | WhatsApp, Telegram, Discord, Signal, Slack, etc.              |
| Plugin Catalog       | Yes      | Public registry contract plus Fased review/install client     |
| Wallet Runtime       | Yes      | Request orchestration, Gateway passkey, skill grants          |
| Native Signer        | Yes      | Go-owned keys, policy, WebAuthn, RPC, caps, execution         |
| MCP Servers          | Yes      | External tool providers                                       |
| User Devices         | Partial  | Mobile apps, desktop clients and Advanced > Nodes diagnostics |

### 1.3 Coverage Limits

No major Fased runtime surface is intentionally excluded. Coverage depth still
varies by area: third-party services, cloud providers, wallets, chains, and
model providers are covered at the Fased integration boundary, not as complete
audits of those external systems.

---

## 2. System Architecture

### 2.1 Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                    UNTRUSTED ZONE                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  WhatsApp   │  │  Telegram   │  │   Discord   │  ...         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
└─────────┼────────────────┼────────────────┼──────────────────────┘
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 1: Channel Access                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      GATEWAY                              │   │
│  │  • Device Pairing (30s grace period)                      │   │
│  │  • AllowFrom / AllowList validation                       │   │
│  │  • Token/Password/Tailscale auth                          │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 2: Session Isolation              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   AGENT SESSIONS                          │   │
│  │  • Session key = agent:channel:peer                       │   │
│  │  • Tool policies per agent                                │   │
│  │  • Agent-scoped skill allowlists                          │   │
│  │  • Transcript logging                                     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 3: Tool Execution                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  EXECUTION SANDBOX                        │   │
│  │  • Docker sandbox OR Host (exec-approvals)                │   │
│  │  • Agent > Tools allow/deny policy                        │   │
│  │  • Node remote execution                                  │   │
│  │  • SSRF protection (DNS pinning + IP blocking)            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 4: External Content               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              FETCHED URLs / EMAILS / WEBHOOKS             │   │
│  │  • External content wrapping (XML tags)                   │   │
│  │  • Security notice injection                              │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 5: Supply Chain                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  PLUGIN CATALOG                           │   │
│  │  • Skill publishing (semver, SKILL.md required)           │   │
│  │  • Pattern-based moderation flags                         │   │
│  │  • Review before install                                  │   │
│  │  • Dependency install remains separate from Agent access   │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              TRUST BOUNDARY 6A: Gateway Wallet Control           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  WALLET ORCHESTRATION                     │   │
│  │  • Role-separated wallets (agent/mining/vault)            │   │
│  │  • Gateway Wallet Control Passkey and review rendering     │   │
│  │  • Wallet > Skill Grants for reviewed skills only         │   │
│  │  • Mining wallet reserved for SAT mining runtime          │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │ typed protocol-v2 intents only
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 6B: Native Signer                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    FASED-SIGNERD                          │   │
│  │  • Go-owned key lifecycle and encrypted state             │   │
│  │  • Fail-closed policy, explicit caps, durable accounting   │   │
│  │  • Signer WebAuthn for exact manual reviews                │   │
│  │  • Execution RPC, broadcast, and exact reconciliation      │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flows

| Flow | Source  | Destination | Data                | Protection                                                    |
| ---- | ------- | ----------- | ------------------- | ------------------------------------------------------------- |
| F1   | Channel | Gateway     | User messages       | TLS, AllowFrom                                                |
| F2   | Gateway | Agent       | Routed messages     | Session isolation                                             |
| F3   | Agent   | Tools       | Tool invocations    | Policy enforcement                                            |
| F4   | Agent   | External    | web_fetch requests  | SSRF blocking                                                 |
| F5   | Catalog | Agent       | Skill files         | Review, moderation, path checks                               |
| F6   | Agent   | Channel     | Responses           | Output filtering                                              |
| F7   | Agent   | Gateway     | Wallet intent       | Role routing, Gateway passkey, explicit skill grants          |
| F8   | Gateway | Signer      | Typed wallet intent | App socket, semantic validation, fail-closed policy, WebAuthn |
| F9   | Signer  | Solana RPC  | Exact transaction   | Signer-owned RPC, durable caps/idempotency, reconciliation    |

---

## 3. Threat Analysis by ATLAS Tactic

### 3.1 Reconnaissance (AML.TA0002)

#### T-RECON-001: Agent Endpoint Discovery

| Attribute               | Value                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0006 - Active Scanning                                          |
| **Description**         | Attacker scans for exposed Fased gateway endpoints                   |
| **Attack Vector**       | Network scanning, shodan queries, DNS enumeration                    |
| **Affected Components** | Gateway, exposed API endpoints                                       |
| **Current Mitigations** | Tailscale auth option, bind to loopback by default                   |
| **Residual Risk**       | Medium - Public gateways discoverable                                |
| **Recommendations**     | Document secure deployment, add rate limiting on discovery endpoints |

#### T-RECON-002: Channel Integration Probing

| Attribute               | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0006 - Active Scanning                                        |
| **Description**         | Attacker probes messaging channels to identify AI-managed accounts |
| **Attack Vector**       | Sending test messages, observing response patterns                 |
| **Affected Components** | All channel integrations                                           |
| **Current Mitigations** | None specific                                                      |
| **Residual Risk**       | Low - Limited value from discovery alone                           |
| **Recommendations**     | Consider response timing randomization                             |

---

### 3.2 Initial Access (AML.TA0004)

#### T-ACCESS-001: Pairing Code Interception

| Attribute               | Value                                                    |
| ----------------------- | -------------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                |
| **Description**         | Attacker intercepts pairing code during 30s grace period |
| **Attack Vector**       | Shoulder surfing, network sniffing, social engineering   |
| **Affected Components** | Device pairing system                                    |
| **Current Mitigations** | 30s expiry, codes sent via existing channel              |
| **Residual Risk**       | Medium - Grace period exploitable                        |
| **Recommendations**     | Reduce grace period, add confirmation step               |

#### T-ACCESS-002: AllowFrom Spoofing

| Attribute               | Value                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                                      |
| **Description**         | Attacker spoofs allowed sender identity in channel                             |
| **Attack Vector**       | Depends on channel - phone number spoofing, username impersonation             |
| **Affected Components** | AllowFrom validation per channel                                               |
| **Current Mitigations** | Channel-specific identity verification                                         |
| **Residual Risk**       | Medium - Some channels vulnerable to spoofing                                  |
| **Recommendations**     | Document channel-specific risks, add cryptographic verification where possible |

#### T-ACCESS-003: Token Theft

| Attribute               | Value                                                       |
| ----------------------- | ----------------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                   |
| **Description**         | Attacker steals authentication tokens from config files     |
| **Attack Vector**       | Malware, unauthorized device access, config backup exposure |
| **Affected Components** | ~/.fased/credentials/, config storage                       |
| **Current Mitigations** | File permissions                                            |
| **Residual Risk**       | High - Tokens stored in plaintext                           |
| **Recommendations**     | Implement token encryption at rest, add token rotation      |

---

### 3.3 Execution (AML.TA0005)

#### T-EXEC-001: Direct Prompt Injection

| Attribute               | Value                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0051.000 - LLM Prompt Injection: Direct                                              |
| **Description**         | Attacker sends crafted prompts to manipulate agent behavior                               |
| **Attack Vector**       | Channel messages containing adversarial instructions                                      |
| **Affected Components** | Agent LLM, all input surfaces                                                             |
| **Current Mitigations** | Pattern detection, external content wrapping                                              |
| **Residual Risk**       | Critical - Detection only, no blocking; sophisticated attacks bypass                      |
| **Recommendations**     | Implement multi-layer defense, output validation, user confirmation for sensitive actions |

#### T-EXEC-002: Indirect Prompt Injection

| Attribute               | Value                                                       |
| ----------------------- | ----------------------------------------------------------- |
| **ATLAS ID**            | AML.T0051.001 - LLM Prompt Injection: Indirect              |
| **Description**         | Attacker embeds malicious instructions in fetched content   |
| **Attack Vector**       | Malicious URLs, poisoned emails, compromised webhooks       |
| **Affected Components** | web_fetch, email ingestion, external data sources           |
| **Current Mitigations** | Content wrapping with XML tags and security notice          |
| **Residual Risk**       | High - LLM may ignore wrapper instructions                  |
| **Recommendations**     | Implement content sanitization, separate execution contexts |

#### T-EXEC-003: Tool Argument Injection

| Attribute               | Value                                                        |
| ----------------------- | ------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0051.000 - LLM Prompt Injection: Direct                 |
| **Description**         | Attacker manipulates tool arguments through prompt injection |
| **Attack Vector**       | Crafted prompts that influence tool parameter values         |
| **Affected Components** | All tool invocations                                         |
| **Current Mitigations** | Exec approvals for dangerous commands                        |
| **Residual Risk**       | High - Relies on user judgment                               |
| **Recommendations**     | Implement argument validation, parameterized tool calls      |

#### T-EXEC-004: Exec Approval Bypass

| Attribute               | Value                                                      |
| ----------------------- | ---------------------------------------------------------- |
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                         |
| **Description**         | Attacker crafts commands that bypass approval allowlist    |
| **Attack Vector**       | Command obfuscation, alias exploitation, path manipulation |
| **Affected Components** | exec-approvals.ts, command allowlist                       |
| **Current Mitigations** | Allowlist + ask mode                                       |
| **Residual Risk**       | High - No command sanitization                             |
| **Recommendations**     | Implement command normalization, expand blocklist          |

---

### 3.4 Persistence (AML.TA0006)

#### T-PERSIST-001: Malicious Skill Installation

- **ATLAS ID:** AML.T0010.001 - Supply Chain Compromise: AI Software.
- **Description:** attacker publishes a malicious skill to the plugin catalog.
- **Attack vector:** create account, publish skill with hidden malicious code.
- **Affected components:** plugin catalog, skill loading, agent execution.
- **Current mitigations:** registry moderation where available, Fased install
  review, path/layout checks, required `SKILL.md`, and Agent allowlist separate
  from install.
- **Residual risk:** High - skills can still steer tool use, and dependency
  installers may introduce supply-chain risk.
- **Recommendations:** package integrity/pinning, stronger external package
  trust warnings, skill sandboxing, community review.

#### T-PERSIST-002: Skill Update Poisoning

| Attribute               | Value                                                                         |
| ----------------------- | ----------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0010.001 - Supply Chain Compromise: AI Software                          |
| **Description**         | Attacker compromises popular skill and pushes malicious update                |
| **Attack Vector**       | Account compromise, social engineering of skill owner                         |
| **Affected Components** | Plugin catalog versioning, auto-update flows                                  |
| **Current Mitigations** | Version fingerprinting, update-risk review before replacing installed content |
| **Residual Risk**       | Medium - Updates can still add dangerous instructions or dependencies         |
| **Recommendations**     | Implement update signing, rollback capability, version pinning                |

#### T-PERSIST-003: Agent Configuration Tampering

| Attribute               | Value                                                           |
| ----------------------- | --------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0010.002 - Supply Chain Compromise: Data                   |
| **Description**         | Attacker modifies agent configuration to persist access         |
| **Attack Vector**       | Config file modification, settings injection                    |
| **Affected Components** | Agent config, tool policies                                     |
| **Current Mitigations** | File permissions                                                |
| **Residual Risk**       | Medium - Requires local access                                  |
| **Recommendations**     | Config integrity verification, audit logging for config changes |

---

### 3.5 Defense Evasion (AML.TA0007)

#### T-EVADE-001: Moderation Pattern Bypass

| Attribute               | Value                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                                     |
| **Description**         | Attacker crafts skill content to evade moderation patterns             |
| **Attack Vector**       | Unicode homoglyphs, encoding tricks, dynamic loading                   |
| **Affected Components** | Plugin registry moderation and Fased skill/archive scanner             |
| **Current Mitigations** | Registry moderation plus Fased archive and permission review           |
| **Residual Risk**       | High - Simple regex easily bypassed                                    |
| **Recommendations**     | Add behavioral analysis (VirusTotal Code Insight), AST-based detection |

#### T-EVADE-002: Content Wrapper Escape

| Attribute               | Value                                                     |
| ----------------------- | --------------------------------------------------------- |
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                        |
| **Description**         | Attacker crafts content that escapes XML wrapper context  |
| **Attack Vector**       | Tag manipulation, context confusion, instruction override |
| **Affected Components** | External content wrapping                                 |
| **Current Mitigations** | XML tags + security notice                                |
| **Residual Risk**       | Medium - Novel escapes discovered regularly               |
| **Recommendations**     | Multiple wrapper layers, output-side validation           |

---

### 3.6 Discovery (AML.TA0008)

#### T-DISC-001: Tool Enumeration

| Attribute               | Value                                                 |
| ----------------------- | ----------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access             |
| **Description**         | Attacker enumerates available tools through prompting |
| **Attack Vector**       | "What tools do you have?" style queries               |
| **Affected Components** | Agent tool registry                                   |
| **Current Mitigations** | None specific                                         |
| **Residual Risk**       | Low - Tools generally documented                      |
| **Recommendations**     | Consider tool visibility controls                     |

#### T-DISC-002: Session Data Extraction

| Attribute               | Value                                                 |
| ----------------------- | ----------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access             |
| **Description**         | Attacker extracts sensitive data from session context |
| **Attack Vector**       | "What did we discuss?" queries, context probing       |
| **Affected Components** | Session transcripts, context window                   |
| **Current Mitigations** | Session isolation per sender                          |
| **Residual Risk**       | Medium - Within-session data accessible               |
| **Recommendations**     | Implement sensitive data redaction in context         |

---

### 3.7 Collection & Exfiltration (AML.TA0009, AML.TA0010)

#### T-EXFIL-001: Data Theft via web_fetch

| Attribute               | Value                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0009 - Collection                                                 |
| **Description**         | Attacker exfiltrates data by instructing agent to send to external URL |
| **Attack Vector**       | Prompt injection causing agent to POST data to attacker server         |
| **Affected Components** | web_fetch tool                                                         |
| **Current Mitigations** | SSRF blocking for internal networks                                    |
| **Residual Risk**       | High - External URLs permitted                                         |
| **Recommendations**     | Implement URL allowlisting, data classification awareness              |

#### T-EXFIL-002: Unauthorized Message Sending

| Attribute               | Value                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0009 - Collection                                           |
| **Description**         | Attacker causes agent to send messages containing sensitive data |
| **Attack Vector**       | Prompt injection causing agent to message attacker               |
| **Affected Components** | Message tool, channel integrations                               |
| **Current Mitigations** | Outbound messaging gating                                        |
| **Residual Risk**       | Medium - Gating may be bypassed                                  |
| **Recommendations**     | Require explicit confirmation for new recipients                 |

#### T-EXFIL-003: Credential Harvesting

- **ATLAS ID:** AML.T0009 - Collection.
- **Description:** malicious skill harvests credentials from agent context.
- **Attack vector:** skill code reads environment variables and config files.
- **Affected components:** skill execution environment.
- **Current mitigations:** skill install/config is separate from Agent access;
  service credentials belong in Services/skill config; wallet and mining grants
  are separate.
- **Residual risk:** High - a malicious allowed skill can still influence the
  Agent to reveal or misuse available context/tools.
- **Recommendations:** skill sandboxing, credential isolation, stronger secret
  redaction and review warnings.

---

### 3.8 Impact (AML.TA0011)

#### T-IMPACT-001: Unauthorized Command Execution

| Attribute               | Value                                               |
| ----------------------- | --------------------------------------------------- |
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity                |
| **Description**         | Attacker executes arbitrary commands on user system |
| **Attack Vector**       | Prompt injection combined with exec approval bypass |
| **Affected Components** | Bash tool, command execution                        |
| **Current Mitigations** | Exec approvals, Docker sandbox option               |
| **Residual Risk**       | Critical - Host execution without sandbox           |
| **Recommendations**     | Default to sandbox, improve approval UX             |

#### T-IMPACT-002: Resource Exhaustion (DoS)

- **ATLAS ID:** AML.T0031 - Erode AI Model Integrity.
- **Description:** attacker exhausts API credits or compute resources.
- **Attack vector:** automated message flooding and expensive tool calls.
- **Affected components:** Gateway, agent sessions, API provider.
- **Current mitigations:** Gateway auth rate limits, task run budgets, provider
  cooldown/failover, and channel/provider backoff where implemented.
- **Residual risk:** High - public or high-volume channels can still exhaust
  account/API/provider resources if policy is too loose.
- **Recommendations:** expand per-sender limits, cost budgets, and operator
  alerts for public/high-volume routes.

#### T-IMPACT-003: Reputation Damage

| Attribute               | Value                                                   |
| ----------------------- | ------------------------------------------------------- |
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity                    |
| **Description**         | Attacker causes agent to send harmful/offensive content |
| **Attack Vector**       | Prompt injection causing inappropriate responses        |
| **Affected Components** | Output generation, channel messaging                    |
| **Current Mitigations** | LLM provider content policies                           |
| **Residual Risk**       | Medium - Provider filters imperfect                     |
| **Recommendations**     | Output filtering layer, user controls                   |

#### T-IMPACT-004: Unauthorized Wallet Or Mining Action

- **ATLAS ID:** AML.T0031 - Erode AI Model Integrity.
- **Description:** attacker causes an Agent or skill to spend funds, change
  wallet policy, or start mining.
- **Attack vector:** prompt injection, malicious skill instructions, overbroad
  tool/wallet grants.
- **Affected components:** Gateway wallet orchestration, native signer, SAT
  mining runtime, Agent tool policy, Skill Grants.
- **Current mitigations:** role-separated wallets, explicit skill grants,
  fail-closed typed signer policy, positive durable caps, signer WebAuthn for
  exact manual reviews, semantic transaction validation, and no generic raw
  signing API.
- **Residual risk:** High - user can still over-grant or approve a malicious
  action.
- **Recommendations:** keep policy/review diffs clear, validate the full
  Local/Hosting/migration/reboot/rollback/concurrency/ambiguity matrix, and use
  on-device hardware review for reserve value where possible.

---

## 4. Plugin Supply Chain Analysis

### 4.1 Current Security Controls

Fased has two different control layers:

- **Plugin registry controls**: public publishing, search, versioning,
  reporting, moderation, and registry metadata.
- **Fased install controls**: the code in this repo that reviews downloaded
  archives before copying skill files into an Agent workspace or shared skill
  library.

- **Trusted registry origin:** install path records and checks the configured
  registry origin. Effectiveness: Medium - prevents silent origin drift.
- **Archive extraction safety:** install flow rejects traversal, symlink,
  oversized, VCS, dependency, and binary-style archive risks. Effectiveness:
  High - prevents common filesystem and archive attacks.
- **Required `SKILL.md`:** `src/agents/skills-marketplace-policy.ts` rejects
  archives without a conventional `SKILL.md`. Effectiveness: Medium - ensures
  the install has a reviewable skill contract.
- **Permission inspection:** `inspectSkillMarketplaceManifest()` records
  requested wallet, tool, and install metadata. Effectiveness: Medium - makes
  risky asks visible before grant.
- **Dependency trust summary:** `summarizeSkillInstallTrust()` flags unpinned
  npm/go/uv/brew/download installers. Effectiveness: Medium - shows
  package-manager trust and integrity gaps.
- **Archive/content scanning:** `src/security/skill-scanner.ts` and plugin
  artifact review surface suspicious files/patterns. Effectiveness: Medium -
  useful guardrail, not a proof of safety.
- **Install Review:** Agent Skills / plugin review flow shows source, warnings,
  permissions, and dependency plan. Effectiveness: Medium - makes source,
  warnings, and dependencies visible before install.
- **Grant Separation:** Agent Skills / Tools / Wallet Skill Grants.
  Effectiveness: High - install does not grant Agent, tool, wallet, mining, or
  vault access.
- **Dependency Verification:** installer result plus requirement check.
  Effectiveness: Medium - command success is not enough; required binaries must
  be visible to gateway PATH.
- **Agent-scoped skill access:** Agent Skills stores allow/deny policy for the
  selected Agent. Effectiveness: High - a skill installed for one Agent is not
  automatically policy-approved everywhere.
- **Wallet role restriction:** skill install policy only permits `agent` wallet
  role requests. Effectiveness: High - generic skills cannot request mining or
  vault wallet roles.

### 4.2 Moderation Flag Patterns

Registry moderation can use denylist and suspicious-pattern checks, but Fased
must not rely on those checks alone. The Fased client-side review path uses
archive scanning, permission extraction, install-plan review, and post-install
dependency verification even when the registry says a skill is visible.

Examples of suspicious patterns a registry or local scanner should treat as
review pressure:

```javascript
/(malware|stealer|phish|phishing|keylogger)/i
/(api[-_ ]?key|token|password|private key|secret)/i
/(wallet|seed phrase|mnemonic|crypto)/i
/(discord\.gg|webhook|hooks\.slack)/i
/(curl[^\n]+\|\s*(sh|bash))/i
/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)/i
```

**Limitations:**

- Pattern checks can miss obfuscated or indirect behavior
- Text-only skill instructions can still steer an Agent toward unsafe tool use
- Simple regex easily bypassed with obfuscation
- No local behavioral analysis proof exists today
- Dependency installers still rely on external package ecosystems unless pinned and reviewed

### 4.3 Planned Improvements

| Improvement                          | Status                     | Impact                                           |
| ------------------------------------ | -------------------------- | ------------------------------------------------ |
| Package integrity/pinning UX         | Recommended next hardening | High - Reduces dependency installer ambiguity    |
| Stronger archive diff review         | Recommended next hardening | Medium - Makes updates easier to audit           |
| Community reporting sync in Fased UI | Future registry work       | Medium - Brings registry trust signals into UI   |
| Runtime sandbox for skills/tools     | Future runtime work        | High - Reduces blast radius after Agent approval |

---

## 5. Risk Matrix

### 5.1 Likelihood vs Impact

| Threat ID     | Likelihood | Impact   | Risk Level   | Priority |
| ------------- | ---------- | -------- | ------------ | -------- |
| T-EXEC-001    | High       | Critical | **Critical** | P0       |
| T-PERSIST-001 | Medium     | Critical | **High**     | P1       |
| T-EXFIL-003   | Medium     | Critical | **High**     | P1       |
| T-IMPACT-004  | Medium     | Critical | **High**     | P1       |
| T-IMPACT-001  | Medium     | Critical | **High**     | P1       |
| T-EXEC-002    | High       | High     | **High**     | P1       |
| T-EXEC-004    | Medium     | High     | **High**     | P1       |
| T-ACCESS-003  | Medium     | High     | **High**     | P1       |
| T-EXFIL-001   | Medium     | High     | **High**     | P1       |
| T-IMPACT-002  | High       | Medium   | **High**     | P1       |
| T-EVADE-001   | High       | Medium   | **Medium**   | P2       |
| T-ACCESS-001  | Low        | High     | **Medium**   | P2       |
| T-ACCESS-002  | Low        | High     | **Medium**   | P2       |
| T-PERSIST-002 | Low        | High     | **Medium**   | P2       |

### 5.2 Critical Path Attack Chains

**Attack Chain 1: Skill-Based Data Theft**

```
T-PERSIST-001 → T-EVADE-001 → T-EXFIL-003
(Publish malicious skill) → (Evade moderation) → (Harvest credentials)
```

**Attack Chain 1b: Skill-Based Wallet Abuse**

```
T-PERSIST-001 → T-EXEC-001 → T-IMPACT-004
(Install malicious skill) → (Steer Agent behavior) → (Over-granted wallet/mining action)
```

**Attack Chain 2: Prompt Injection to RCE**

```
T-EXEC-001 → T-EXEC-004 → T-IMPACT-001
(Inject prompt) → (Bypass exec approval) → (Execute commands)
```

**Attack Chain 3: Indirect Injection via Fetched Content**

```
T-EXEC-002 → T-EXFIL-001 → External exfiltration
(Poison URL content) → (Agent fetches & follows instructions) → (Data sent to attacker)
```

---

## 6. Recommendations Summary

### 6.1 Immediate (P0)

| ID    | Recommendation                                      | Addresses                    |
| ----- | --------------------------------------------------- | ---------------------------- |
| R-001 | Package integrity/pinning for dependency installers | T-PERSIST-001, T-PERSIST-002 |
| R-002 | Implement skill sandboxing                          | T-PERSIST-001, T-EXFIL-003   |
| R-003 | Add output validation for sensitive actions         | T-EXEC-001, T-EXEC-002       |

### 6.2 Short-term (P1)

| ID    | Recommendation                                          | Addresses    |
| ----- | ------------------------------------------------------- | ------------ |
| R-004 | Expand rate limiting, cost budgets, and operator alerts | T-IMPACT-002 |
| R-005 | Add token encryption at rest                            | T-ACCESS-003 |
| R-006 | Improve exec approval UX and validation                 | T-EXEC-004   |
| R-007 | Implement URL allowlisting for web_fetch                | T-EXFIL-001  |
| R-011 | Improve wallet approval diffs and policy simulation     | T-IMPACT-004 |

### 6.3 Medium-term (P2)

| ID    | Recommendation                                        | Addresses     |
| ----- | ----------------------------------------------------- | ------------- |
| R-008 | Add cryptographic channel verification where possible | T-ACCESS-002  |
| R-009 | Implement config integrity verification               | T-PERSIST-003 |
| R-010 | Add update signing and version pinning                | T-PERSIST-002 |

---

## 7. Appendices

### 7.1 ATLAS Technique Mapping

| ATLAS ID      | Technique Name                 | Fased Threats                                                    |
| ------------- | ------------------------------ | ---------------------------------------------------------------- |
| AML.T0006     | Active Scanning                | T-RECON-001, T-RECON-002                                         |
| AML.T0009     | Collection                     | T-EXFIL-001, T-EXFIL-002, T-EXFIL-003                            |
| AML.T0010.001 | Supply Chain: AI Software      | T-PERSIST-001, T-PERSIST-002                                     |
| AML.T0010.002 | Supply Chain: Data             | T-PERSIST-003                                                    |
| AML.T0031     | Erode AI Model Integrity       | T-IMPACT-001, T-IMPACT-002, T-IMPACT-003, T-IMPACT-004           |
| AML.T0040     | AI Model Inference API Access  | T-ACCESS-001, T-ACCESS-002, T-ACCESS-003, T-DISC-001, T-DISC-002 |
| AML.T0043     | Craft Adversarial Data         | T-EXEC-004, T-EVADE-001, T-EVADE-002                             |
| AML.T0051.000 | LLM Prompt Injection: Direct   | T-EXEC-001, T-EXEC-003                                           |
| AML.T0051.001 | LLM Prompt Injection: Indirect | T-EXEC-002                                                       |

### 7.2 Key Security Files

| Path                                      | Purpose                     | Risk Level   |
| ----------------------------------------- | --------------------------- | ------------ |
| `src/infra/exec-approvals.ts`             | Command approval logic      | **Critical** |
| `src/gateway/auth.ts`                     | Gateway authentication      | **Critical** |
| `src/web/inbound/access-control.ts`       | Channel access control      | **Critical** |
| `src/infra/net/ssrf.ts`                   | SSRF protection             | **Critical** |
| `src/security/external-content.ts`        | Prompt injection mitigation | **Critical** |
| `src/agents/sandbox/tool-policy.ts`       | Tool policy enforcement     | **Critical** |
| `src/security/skill-scanner.ts`           | Skill archive scanner       | **High**     |
| `src/agents/skills-marketplace-policy.ts` | Skill permission inspection | **High**     |
| `src/agents/skills-install-trust.ts`      | Dependency trust summary    | **High**     |
| `src/routing/resolve-route.ts`            | Session isolation           | **Medium**   |
| `src/wallet/`                             | Wallet policy and approvals | **Critical** |
| `src/mining/`                             | SAT mining runtime policy   | **Critical** |

### 7.3 Glossary

| Term                 | Definition                                                |
| -------------------- | --------------------------------------------------------- |
| **ATLAS**            | MITRE's Adversarial Threat Landscape for AI Systems       |
| **Plugin catalog**   | Fased's reviewable skill and plugin discovery surface     |
| **Gateway**          | Fased's message routing and authentication layer          |
| **MCP**              | Model Context Protocol - tool provider interface          |
| **Prompt Injection** | Attack where malicious instructions are embedded in input |
| **Skill**            | Downloadable extension for Fased agents                   |
| **Skill Grant**      | Explicit wallet permission granted to a reviewed skill    |
| **SSRF**             | Server-Side Request Forgery                               |

---

_This threat model is a living document. For security issues, use the repository policy in `SECURITY.md`._
