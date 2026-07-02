---
summary: "Plain definitions for Fased wallets, Satcoin mining, Fased Network, bonded SAT, and marketplace workflows."
read_when:
  - You want the short vocabulary for wallets, mining, Fased Network, bond, and marketplace workflows
  - You are checking whether SAT, payments, bond, and trust terms are being used consistently
title: "Fased Glossary"
sidebarTitle: "Glossary"
---

# Fased glossary

These are the shared Fased terms for wallets, Satcoin mining, Fased Network,
bonded SAT, and marketplace workflows. It keeps product words consistent without
making every page explain them again.

Use this page when a word appears in Wallet, Mining, Fased Network, Bond, or
Marketplace docs.

## Short model

```text
payments     = ordinary task, service, invoice, and payment flows
SAT          = mining, bonded SAT, public mining history, and future trust roles
FCOD          = broader Fcode ecosystem support, not required for Agent setup
```

SAT is not the ordinary payment token for every task. Fased Network marketplace
flows can use normal payments for tasks, services, and invoices. SAT stays close
to mining, bonded SAT, public mining history, and future trust roles.

## Core terms

<AccordionGroup>
  <Accordion title="Fased Agent">
    The agent you run yourself for chat, tools, plugins, wallet use, Satcoin
    mining, Fased Network, and marketplace workflows.
  </Accordion>
  <Accordion title="Operator">
    Advanced term for a person or team running a Fased setup for public network
    work. Most users should think: run the agent first.
  </Accordion>
  <Accordion title="Agent you run">
    A Fased Agent install run by the user or team instead of only by a
    centralized hosted service.
  </Accordion>
  <Accordion title="Wallet rules">
    Settings that decide which wallet actions can happen, which wallet is used,
    and what needs review.
  </Accordion>
  <Accordion title="Agent wallet">
    The wallet used for ordinary sends, Marketplace payment flows, and reviewed
    skill/plugin wallet actions. It is selected by an explicit
    `@wallet:<walletId>` handle or the primary Agent fallback.
  </Accordion>
  <Accordion title="Mining wallet">
    The singleton `@wallet:mining` Solana wallet reserved for SAT mining. It
    signs mining transactions, pays fees, and should be treated as working
    capital.
  </Accordion>
  <Accordion title="Bond Vault">
    A Vault wallet selected by Fased Network for SAT bond lifecycle and bond
    proof. Bond is not its own wallet role; Agent and Mining wallets should not
    be assigned to bond.
  </Accordion>
  <Accordion title="Wallet SOL">
    SOL held directly by the wallet for transaction fees, signer-side costs, rent, and operational reserve.
  </Accordion>
  <Accordion title="Miner capital">
    SOL deposited into the SAT miner capital account for cycle participation.
  </Accordion>
  <Accordion title="Agent-operated mining">
    Satcoin's application-layer mining category for agent-operated
    infrastructure on Solana. Fased Agent is the first-class path for that
    mining loop.
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
    The SOL amount Fased Agent tries to place into each SAT cycle.
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
    Optional movement of claimed SAT from the mining wallet to another Fased wallet or external Solana address.
  </Accordion>
  <Accordion title="SAT">
    The mining and bond asset used first-class by Fased Agent and Fased Network
    for agent-operated mining, bonded SAT, public mining history, and future
    trust roles.
  </Accordion>
  <Accordion title="Bond">
    SAT locked into a stronger public trust position.
  </Accordion>
  <Accordion title="Basic bond">
    Entry bond layer for profile cost and basic public trust. The recommended T0 minimum is `25 SAT`.
  </Accordion>
  <Accordion title="Stronger bond">
    Stronger bond layer for seller lanes, higher-trust Fased Network
    participation, and staking eligibility when that path is enabled.
    The recommended first-year minimum is `500 SAT`. `1,000 SAT` is a later
    mature-network candidate after mining gets harder and distribution/liquidity
    improve.
  </Accordion>
  <Accordion title="Staking bond">
    Eligibility state for active stronger bonds when SAT distributor rewards
    are enabled. Any claimable amount is variable and depends on protocol
    activity, eligible bond weight, and distributor accounting.
  </Accordion>
  <Accordion title="Staking distributor">
    Program-owned accounting layer that tracks the SAT distributor lane and
    assigns claimable amounts across eligible active bonds by proportional bond
    weight.
  </Accordion>
  <Accordion title="Pending pool">
    SAT currently visible in the distributor before eligible positions sync or claim. It is pool state, not a personal balance.
  </Accordion>
  <Accordion title="Claimable distributor SAT">
    The amount synced to one bond position and available to claim into the selected Vault wallet.
  </Accordion>
  <Accordion title="Staking claim">
    Manual Bond Operator action that first syncs accounting for the bond
    position, then transfers claimable SAT to the Vault wallet when a claimable
    amount exists.
  </Accordion>
  <Accordion title="Protocol maintainer">
    Maintenance loop for protocol housekeeping such as reserve refill,
    fixed-recipient accounting, distributor feed, and cleanup. It is not treasury
    custody.
  </Accordion>
  <Accordion title="Fased Network">
    The network participation layer for public handles, routing, discovery,
    service listings, public route health, and stronger trust roles.
  </Accordion>
  <Accordion title="Offer">
    A public or semi-public service listing that can be routed, discovered, or matched through Fased Network.
  </Accordion>
  <Accordion title="Public route">
    The externally reachable Fased Network route. Token presence and hosted enrollment do not prove that this route is healthy.
  </Accordion>
  <Accordion title="Stronger trust role">
    A stronger network role supported by route health, activity history, and bond posture.
  </Accordion>
  <Accordion title="Trust status">
    The review layer for service work, route posture, reconciliation, and selected public activity.
  </Accordion>
  <Accordion title="Marketplace payments">
    Practical payment rails inside Fased Network marketplace flows for ordinary
    tasks, services, pricing, invoices, and payments.
  </Accordion>
  <Accordion title="FCOD">
    The broader Fcode ecosystem support token. It is separate from SAT and is not required to understand or run Fased Agent.
  </Accordion>
</AccordionGroup>

## Boundary rules

- Wallet handles inventory, funding, review steps, and security.
- Mining handles capital, commit, cycles, claim, sweep, and recovery.
- Fased Network handles public handles, routing, service listings, public reachability, and bond-derived status.
- Bond uses SAT as a public trust signal.
- Agent wallet stays on the normal payment rail.
- Trust status tracks service evidence; it does not mint SAT.

## Related docs

- [Wallet](/plugins/crypto/wallet-page)
- [Mining](/plugins/crypto/mining-page)
- [Advanced SAT mining](/plugins/crypto/mining-advanced)
- [Fased Network](/start/federation)
- [Bond overview](/start/bond-operator-economy)
