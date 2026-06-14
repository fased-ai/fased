---
summary: "Shared definitions for Fased wallets, SAT mining, Fased Network, bond, and operator workflows."
read_when:
  - You want the short vocabulary for wallets, mining, Fased Network, bond, and operator workflows
  - You are checking whether SAT, payments, bond, and operator terms are being used consistently
title: "Operator Glossary"
sidebarTitle: "Glossary"
---

# Operator glossary

These are the shared Fased terms for wallets, SAT mining, Fased Network, bond,
and operator workflows.

Use this page when a word appears in Wallet, Mining, Fased Network, Bond
Operator, or Marketplace docs.

## Short model

```text
payments = ordinary task and service payment rails
SAT      = mining, bond, and operator trust
FCOD     = broader Fcode ecosystem support
```

SAT is not the ordinary payment token for every task. Stable payment rails can
handle normal task/service payments. SAT stays close to mining, bond,
anti-spam cost, and operator trust.

## Core terms

<AccordionGroup>
  <Accordion title="Fased Agent">
    The self-hosted runtime for agent sessions, plugins, wallet policy, SAT mining, Fased Network, and operator workflows.
  </Accordion>
  <Accordion title="Operator">
    A user who runs and maintains infrastructure instead of only using hosted access. Operators own runtime health, wallet boundaries, and network posture.
  </Accordion>
  <Accordion title="Owned agent">
    A Fased Agent node controlled by the user or operator instead of only by a centralized hosted service.
  </Accordion>
  <Accordion title="Wallet policy">
    Rules that decide what a wallet-connected runtime can do, how much it can spend, what requires approval, and which balances stay separated.
  </Accordion>
  <Accordion title="Agent wallet">
    The wallet used for ordinary sends, receipts, Marketplace payment flows, and reviewed skill/plugin wallet actions. It is selected by explicit `@wallet:<walletId>` handle or the primary Agent fallback.
  </Accordion>
  <Accordion title="Mining wallet">
    The singleton `@wallet:mining` Solana wallet reserved for SAT mining. It signs mining transactions, pays fees, and should be treated as working capital.
  </Accordion>
  <Accordion title="Bond Vault">
    A Vault wallet selected by Fased Network for SAT bond lifecycle and bond proof. Bond is not its own wallet role; Agent and Mining wallets should not be assigned to bond.
  </Accordion>
  <Accordion title="Wallet SOL">
    SOL held directly by the wallet for transaction fees, signer-side costs, rent, and operational reserve.
  </Accordion>
  <Accordion title="Miner capital">
    SOL deposited into the SAT miner capital account for cycle participation.
  </Accordion>
  <Accordion title="Agent-operated mining">
    Satcoin's application-layer mining category for agent-operated
    infrastructure on Solana. Fased Agent is the first-class runtime path for
    that mining loop.
  </Accordion>
  <Accordion title="Free capital">
    Miner capital that can be committed or withdrawn now.
  </Accordion>
  <Accordion title="Locked capital">
    Miner capital tied to pending or live cycles. Stop does not instantly unlock it.
  </Accordion>
  <Accordion title="Clearing">
    Stop state where new cycle submits are off while claim and recovery keep working through already-submitted cycles.
  </Accordion>
  <Accordion title="Resume">
    Mining action that exits clearing and allows new cycle submits again.
  </Accordion>
  <Accordion title="Active commit">
    The SOL amount the runtime tries to place into each SAT cycle.
  </Accordion>
  <Accordion title="Cycle">
    The five-minute SAT mining window.
  </Accordion>
  <Accordion title="Erosion">
    The per-cycle SOL cost charged against committed capital.
  </Accordion>
  <Accordion title="Rebate">
    SOL credited back to miner capital after cycle accounting.
  </Accordion>
  <Accordion title="Claim">
    The action that mints earned SAT and accounts miner rebate after cycle accounting.
  </Accordion>
  <Accordion title="Sweep">
    Optional movement of claimed SAT from the mining wallet to another runtime wallet or external Solana address.
  </Accordion>
  <Accordion title="SAT">
    The mining and bond asset used first-class by Fased Agent and Fased Network
    for agent-operated mining, operator trust, anti-spam cost, and stronger
    network roles.
  </Accordion>
  <Accordion title="Bond">
    SAT locked into a trust-bearing operator position.
  </Accordion>
  <Accordion title="Basic bond">
    Entry bond layer for identity, anti-spam cost, and basic profile trust. The recommended T0 minimum is `25 SAT`.
  </Accordion>
  <Accordion title="Operator bond">
    Stronger bond layer for seller lanes, operator roles, higher-trust Fased Network participation, and staking eligibility when that path is enabled. The recommended first-year minimum is `500 SAT`; `1,000 SAT` is a later mature-network candidate after mining gets harder and distribution/liquidity improve.
  </Accordion>
  <Accordion title="Staking bond">
    Eligibility state for active operator bonds when SAT staking distribution is enabled. Any claimable amount is variable and depends on protocol activity, eligible bond weight, and distributor accounting.
  </Accordion>
  <Accordion title="Staking distributor">
    Program-owned accounting layer that tracks the staking SAT lane and assigns claimable amounts across eligible active staking bonds by proportional bond weight.
  </Accordion>
  <Accordion title="Pending pool">
    SAT currently visible in the distributor before eligible positions sync or claim. It is pool state, not a personal balance.
  </Accordion>
  <Accordion title="Claimable staking SAT">
    The amount synced to one bond position and available to claim into the selected Vault wallet.
  </Accordion>
  <Accordion title="Staking claim">
    Manual Bond Operator action that first syncs accounting for the bond position, then transfers claimable SAT to the Vault wallet when a claimable amount exists.
  </Accordion>
  <Accordion title="Protocol maintainer">
    Operator loop for protocol housekeeping such as reserve refill, fixed-recipient accounting, distributor feed, and cleanup. It is not treasury custody.
  </Accordion>
  <Accordion title="Fased Network">
    The network participation layer for identity, routing, discovery, offers, public route health, and trusted operator roles.
  </Accordion>
  <Accordion title="Offer">
    A public or semi-public service listing that can be routed, discovered, or matched through Fased Network.
  </Accordion>
  <Accordion title="Public route">
    The externally reachable Fased Network route. Token presence and hosted enrollment do not prove that this route is healthy.
  </Accordion>
  <Accordion title="Trusted role">
    A stronger network role unlocked by verified identity, route health, history, and bond posture.
  </Accordion>
  <Accordion title="Operator status">
    The evidence and review layer for service work, route posture, reconciliation, and selected operator records.
  </Accordion>
  <Accordion title="Stable payments">
    Practical payment rails for ordinary tasks, services, marketplace pricing, invoices, and receipts.
  </Accordion>
  <Accordion title="FCOD">
    The broader Fcode ecosystem support token. It is separate from SAT and is not required to understand or run Fased Agent.
  </Accordion>
</AccordionGroup>

## Boundary rules

- Wallet handles inventory, funding, policy, approvals, and security.
- Mining handles capital, commit, cycles, claim, sweep, and recovery.
- Fased Network handles identity, routing, offers, public reachability, and bond-derived status.
- Bond uses SAT as an operator trust signal.
- Agent wallet stays on the normal payment rail.
- Operator status tracks service evidence; it does not mint SAT.

## Related docs

- [Wallet](/plugins/crypto/wallet-page)
- [Mining](/plugins/crypto/mining-page)
- [Advanced SAT mining](/plugins/crypto/mining-advanced)
- [Fased Network](/start/federation)
- [Bond operator](/start/bond-operator-economy)
