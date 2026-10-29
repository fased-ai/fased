---
title: "Network roadmap"
description: "Shared trading intelligence, server reuse and staged delivery."
---

This is an approved future roadmap, separate from the current Fased core implementation queue. Each stage needs an explicit implementation scope and acceptance. No server startup, public API, subscription, trading, token distribution or mining activation follows from this page.

## Connected stages

| Stage                | Deliverable                                                                   | Completion boundary                                                                   |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1. Contract          | Identity, signal, research request, version, outcome and permission records   | Exact market/source/time semantics, durable publication and revocation rules agreed   |
| 2. Shared signals    | Publish → discover/follow → receive in Fased and WEN → inspect source/history | One signal is useful in both apps without granting execution                          |
| 3. Paper evaluation  | Subscribe → evaluate → reviewed Task → recorded result                        | Same Go engine, bounded allocation and attributable version; paper remains labelled   |
| 4. One venue         | One independently accepted execution adapter                                  | Owner limits, signer separation, submit/cancel/reconcile and recovery work together   |
| 5. Paid services     | Research requests, signal subscriptions and API plans                         | Durable delivery, access revocation, explicit price, obligations and payment outcomes |
| 6. Funded FCOD pools | Explicit allocation of available net business income                          | Actual revenue, funded budgets and published pool terms before distribution           |

The first network deliverable is one shared signal journey. Broad federation, autonomous swarms and monetized reputation follow evidence. Network work cannot become a prerequisite for ordinary installation, local agent use or WEN participation.

## Reuse the existing server

The TypeScript server repository contains identity/directory/control-plane code, a signed-event relay, A2A handlers, indexing and payment-related structures. These are candidate components, not a deployed trading-network claim.

| Component                                                                | Direction                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Identity, directory, relay                                               | Retain useful modules after binding identity, scope, expiry and ownership consistently                        |
| A2A transport                                                            | Reuse transport concepts with trading-specific versioned requests/results and durable delivery                |
| Generic task/summary schemas and in-memory task maps                     | Replace their trading use with durable signal/research/outcome records; they do not prove financial execution |
| Service index and payment records                                        | Adapt later for signal feeds and defined research services; subscriptions never authorize wallet spending     |
| SAT bonds, broad marketplace permissions and automatic seller privileges | Retire from the new trading design; preserve historical records and obligations                               |
| ActivityPub, IPFS pinning and managed public tunnels                     | Optional later modules only where a concrete trading use requires them                                        |
| Go core and signer                                                       | Remain in Fased App; no second strategy engine or hosted signing service in the network server                |

Fcode API is the developer-facing access to this same network. It shares identities, signals, research jobs, entitlements and outcome records; it is not another engine or token. Exact endpoints and API compatibility remain to be specified; none are advertised as available here.

## Economics

Signal subscriptions pay for a named feed; agent research requests pay for a defined result; API plans pay for access, delivery capacity and availability. Supported trading integrations may collect separately disclosed execution fees.

Account for publisher compensation, operating costs and FCOD allocations separately. Reward useful delivery, not message volume or unnecessary trades. FCOD access discounts or payment options remain later proposals, not implemented benefits. Basic installation is independent of token ownership, and token holdings do not establish signal credibility or spending authority.

See [Network](/guide/network), [FCOD](https://docs.fcode.ai/fcod) and [product status](/reference/roadmap).
