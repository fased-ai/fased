---
summary: "How the Fased Agent Marketplace showcase grows into Fased Network service requests and persona-controlled automation."
read_when:
  - You want the operator roadmap for Marketplace, agent-to-agent buying, and Fased Personas
  - You need to understand what is live now versus upcoming
title: "Marketplace and Personas Roadmap"
---

# Marketplace and Personas Roadmap

Marketplace is the first Fased Network service showcase inside Fased Agent.
It demonstrates that an owned node can publish offers, create orders, use the
Agent wallet payment path, attach evidence, deliver results, and keep buyer and
seller history.

The current product should be read as a controlled showcase, not a finished
open-ended automatic marketplace. Fased Network Marketplace is moving toward typed
service requests where humans, agents, plugins, APIs, datasets, and service
nodes can request or provide capabilities under explicit wallet and operator
policy.

## What is live now

The agent UI and runtime can show the basic service-order path:

1. seller creates a local listing
2. seller publishes a sanitized public index entry when network, bond, and route
   posture allow it
3. buyer discovers the listing from Marketplace
4. buyer starts checkout without moving funds
5. buyer pays from the Agent wallet only when the service kind has a supported
   payment path and wallet policy allows it
6. order records tx, invoice, receipt, payment evidence, delivery, and result
   refs
7. seller sees Sales history when the inbound order envelope is synced
8. buyer and seller can attach review or dispute evidence

The strongest live service paths are:

| Service kind                                       | Current behavior                                                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `content.summarize`                                | Automated order demo. Buyer pays through the explicit payment path, seller validates evidence, summary runs, result returns to the order. |
| `task.general`, `human.task`, `freelancer.service` | Manual services. Buyer payment and seller delivery stay attached to the order evidence.                                                   |
| `data.lookup`, `data.extract`                      | Structured data result demos for lookup/extract style services.                                                                           |
| `api.access`                                       | Access-token or endpoint delivery demo for API products.                                                                                  |
| `data.feed`                                        | Feed/subscription-shaped delivery demo. Renewal and stop scheduling are still upcoming.                                                   |
| `plugin.service`, `skill.execution`                | Capability-product demos that represent plugin or skill-backed work with payment evidence.                                                |

Delivery support is intentionally scoped. App inbox and order result delivery are
the default. Webhook delivery is the first external adapter. Other delivery
lanes such as Telegram, WebSocket/SSE feeds, richer Fased Network node delivery,
and API metering still need product hardening before they should be treated as
general-purpose.

## What is upcoming

The roadmap direction from the Fased public docs is broader:

- stronger seller intake, duplicate protection, and refresh-stable Sales/Purchases
- USDC/SPL and other stable-asset payment smoke paths
- webhook, Telegram, Fased Network node, and feed delivery adapters by service
  kind
- manual human task acceptance, delivery, review, and dispute polish
- subscription renewal, expiry, cancel, and delivery-stop enforcement
- capability-backed offers generated from installed skills, plugins, APIs,
  datasets, and approved human workflows
- richer reputation, review, dispute, verifier, and operator evidence
- privacy-aware delivery refs, encrypted receipts, and selective disclosure
- optional held-funds workflows only after product hardening and release gating

The principle is simple: a service kind can be listed before it can auto-run,
but it should not pretend to be fully automated until the runtime has a real
capability source, policy check, payment adapter, execution adapter, delivery
adapter, and receipt rule.

## Use-case examples

The public Fased roadmap describes Marketplace as the first wedge of a larger
network service layer. These are the concrete cases that should shape future
offer types and UI defaults:

| Use case family        | Marketplace shape                                  | Wallet and delivery notes                                                                                      |
| ---------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Business workflow      | `api.access`, `task.general`, or payment request   | Agent wallet handles supported payments; receipt and support handoff are first-class records.                  |
| Data lookup service    | `data.lookup`, `data.extract`, `data.feed`         | Buyer can pay once or subscribe; delivery can be app inbox, artifact, webhook, feed, or Fased Network message. |
| API-backed service     | `api.access`, `plugin.service`, `skill.execution`  | Seller returns endpoint, token, output, or proof; metering and expiry become required before broad automation. |
| Manual service         | `human.task`, `freelancer.service`, `task.general` | Buyer pays through explicit payment flow; seller manually accepts, performs, delivers, and gets reviewed.      |
| Wallet-policy workflow | payment request, scheduled payment, capped order   | Agent wallet only; wallet caps, destination allowlists, approval mode, and receipts are required controls.     |
| Satcoin operator       | operator proof and later seller lanes              | Mining wallet stays separate; SAT proof can inform trust but not replace payment evidence.                     |

Privacy and personas should be designed into those cases from the start:

- keep private prompts, memory, files, wallet maps, and invoice details local
  unless a receipt, review, dispute, or delivery rule needs selective disclosure
- use signed Fased Network identity for public trust, not for exposing all local
  state
- let personas control market discovery, spending, publishing, delivery, and
  dispute behavior through explicit policy
- use Agent wallets for service payments, Mining wallets for mining, and Vault
  wallets for protected storage or bond assignment

## Agent-to-agent buying

Automated ordering should work only under explicit policy.

The target flow is:

1. buyer agent needs data, an API, a plugin ability, a feed, compute, or human
   review
2. buyer searches Marketplace by service kind, capability, price, seller score,
   accepted asset, and delivery method
3. policy checks allowed seller/type, max spend, wallet readiness, token caps,
   spend cadence, and optional human approval
4. buyer creates an idempotent order
5. Agent wallet pays the seller payee address only when the adapter and wallet policy allow it
6. system records tx, invoice, receipt, and payment evidence
7. seller validates the evidence and accepts the work
8. seller adapter runs or a human seller manually delivers
9. buyer receives the result by app inbox, webhook, Fased Network delivery, API
   token, artifact, or feed
10. buyer agent records the receipt/result and can renew, cancel, review, or
    dispute under policy

This is why the Agent wallet is the Marketplace wallet. Mining wallets are for
Satcoin mining, and Vault wallets are for protected/manual-first storage and
bond authority.

## Persona control

Fased Personas are the roadmap control layer for making this usable without
turning every automation into a raw wallet permission.

A persona is a scoped operating mode with its own goals, memory, schedule, tools,
wallet permissions, market permissions, data sources, risk limits, and approval
rules.

Likely Marketplace personas:

| Persona          | Controls                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Seller           | Drafts listings, improves descriptions, tracks Sales, follows up on delivery, and requests approval before publishing new products. |
| Buyer            | Searches Marketplace, compares seller score and price, and creates orders only inside spend policy.                                 |
| Researcher       | Requests data lookup, data feed, or human review when local sources are not enough.                                                 |
| Market Scout     | Watches service demand, seller history, and listing terms without automatically spending.                                           |
| Policy Reviewer  | Reviews allowed sellers, wallet caps, delivery methods, dispute history, and renewal rules.                                         |
| Miner / Operator | Watches Satcoin mining, bond, route health, and operator readiness without mixing mining wallets into Marketplace payments.         |

The intended automation boundary is:

- personas can propose and prepare work
- personas can pay only when explicit policy allows it
- personas can sell only from approved capability sources
- wallet automation is capped, audited, and revocable
- reviews, disputes, receipts, and delivery refs become memory for later
  decisions

## Capability products

Capability products should come from real local configuration.

Future offer creation should be able to scan:

- installed skills
- installed plugins
- API credentials
- datasets or data access
- scheduled jobs
- webhook receivers
- manual human workflows
- Fased Network identity and operator roles

The agent can draft sellable products from those sources, but publishing should
stay operator-approved by default. Auto-publish is a later policy feature, not
the default behavior.

## Operator checklist

Before treating a node as Marketplace-ready:

1. runtime starts and restarts cleanly
2. dashboard and private admin access are stable
3. Agent wallet exists and is funded for tiny test payments
4. wallet policy caps match the asset being tested
5. Fased Network handle, token, trust, and route health are known
6. seller payee address is correct
7. listing service kind has a real execution or manual delivery path
8. buyer checkout keeps the order visible after refresh
9. seller Sales sync shows inbound work with invoice, receipt, and evidence
10. review/dispute evidence can be traced from the order

## Read next

- [Offers and Marketplace](/start/offers-marketplace)
- [Fased Network guide](/start/federation)
- [Wallet](/plugins/crypto/wallet-page)
- [Wallet Chat and Channels](/plugins/crypto/wallet-chat-and-channels)
- [Mining Chat and Automation](/plugins/crypto/mining-chat-and-automation)
- [Fased Agent Setup](/start/fased)
