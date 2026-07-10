---
summary: "Which production dependencies belong to Fased core and which runtime groups are extraction targets."
read_when:
  - You are changing production dependencies
  - You are reducing install or update size
  - You are moving a provider, channel, browser, media, or memory runtime out of core
title: "Dependency Ownership"
---

# Dependency ownership

Fased keeps the Agent and crypto path stable while optional runtimes move out of
the default install. The checked source is
`config/dependency-ownership.json`.

Run the report:

```bash
pnpm dependency:ownership
pnpm --silent dependency:ownership -- --json
```

`pnpm release:check` fails when a production dependency has no owner, has more
than one owner, or remains in the ownership file after removal from
`package.json`.

## Delivery groups

| Group                         | Current decision | Direction                                      |
| ----------------------------- | ---------------- | ---------------------------------------------- |
| Agent Core                    | core             | keep                                           |
| Wallet And Mining Core        | core             | keep                                           |
| Fased Network                 | core             | keep                                           |
| Amazon Bedrock Provider       | provider add-on  | extract                                        |
| Google Provider Compatibility | provider add-on  | audit before provider split                    |
| Bundled Advanced Channels     | channel add-on   | extract channel by channel                     |
| Browser Runtime               | runtime add-on   | extract browser libraries from the default set |
| Media Runtime                 | runtime add-on   | extract native and document-processing weight  |
| Speech Runtime                | runtime add-on   | extract                                        |
| Native Local Memory           | runtime add-on   | extract native vector runtime                  |

## Core protection

Package work must preserve these fresh-install checks:

```text
Agent starts
Tasks load
Wallet CLI loads
SAT mining loads
Fased Network loads
Control UI loads
Provider configuration remains available
```

Moving a dependency does not mean removing its feature. The feature gains an
explicit install boundary and lifecycle state. The component catalog reports
`not-installed`, `configured`, `ready`, or `error` instead of showing a setup
field as proof that its runtime exists.

## Extraction order

1. Advanced channel SDKs that serve one channel family.
2. Browser libraries and the system browser boundary.
3. Media and speech runtimes.
4. Native local-memory dependencies.
5. Provider-specific SDKs.

Each extraction needs a packed-core smoke, an add-on smoke, and a docs update.
Do not combine those moves into one release-sized change.
