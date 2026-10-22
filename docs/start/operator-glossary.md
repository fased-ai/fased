---
summary: "Plain definitions for Fased, Satcoin Mining and separately owned funds."
read_when:
  - You want the vocabulary for wallets, WEN and Fased Network
title: "Fased glossary"
---

# Fased glossary

Fased is the personal agent. WEN is the Asset Mining platform, starting with Satcoin Mining. Satcoin is the mined asset; SAT is used for quantities. Fased Network handles identity, routing and discovery.

## Wallets and permissions

| Term            | Meaning                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------- |
| Wallet          | An account selected for an operation. Its label does not authorize spending.                    |
| Wallet policy   | The permitted chain, programs, assets, actions, destinations and spending limits.               |
| Bounded session | Permission for specified future rounds, amounts and duration, with explicit stop conditions.    |
| Claim           | Collect an earned entitlement. Trading or reinvesting the proceeds requires its own permission. |

See [wallet policies](/plugins/crypto/wallet-roles-and-policies) and [WEN automation](/wen/automation).

## Satcoin Mining

| Term               | Meaning                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Mining budget      | Maximum SOL permitted for a strategy. Uncommitted funds remain available to their owner.                                               |
| Round              | A ten-minute BTC measurement with published entry, reveal and settlement timing.                                                       |
| Range              | One of five published BTC-move intervals. Multi-range allocations are permitted.                                                       |
| Accuracy credit    | Full credit for an exact range, with partial credit for eligible nearby outcomes.                                                      |
| Capital × accuracy | The weight used to share released fresh BTC rewards and unlocked SAT.                                                                  |
| Crowding           | Competing capital and accuracy weights that determine the denominator of a reward share.                                               |
| Principal return   | Exact entries return 99% after the 1% fee; incorrect revealed entries return 90%–95% before separate rewards and execution costs.      |
| SAT unlock         | Accepted capital unlocks the scheduled award proportionally up to 5 SOL; highest occupied credit and remaining caps constrain release. |
| SAT supply         | 1,000,000 cumulative lifetime issuance including 50,000 Genesis SAT; at most 50,000 mining SAT per year.                               |
| Carry              | Miner reward funds not released in their originating round, with recorded contributors, release limits and expiry.                     |
| SAT staking        | Eligible staked SAT shares funded BTC. Staking does not mint SAT.                                                                      |
| Daily competition  | Wallet/team capital competition funded by 1% of actual forfeitures, using complete net round results.                                  |
| Treasury           | Receives 5% of forfeitures, split equally toward BTC and USDC; bought SAT remains locked without staking or burning.                   |
| Operating          | Receives its 10% forfeiture allocation and exact-entry fees, and pays its disclosed shared costs.                                      |

The full forfeiture split is 74% miners, 1% daily competition, 10% staking, 10% Operating and 5% treasury. Principal, rewards, treasury inventory and Operating income have distinct ownership and purposes.

Mining returns depend on allocations, competition, costs and executable sale proceeds. Read [Satcoin](https://docs.satcoin.app) and [WEN](/wen/index) for the product rules and availability. The Fased integration remains in development.

## Fcode Lab and Network

**Fcode Lab** is the umbrella behind WEN and Fased. **FCOD** is the Lab token; planned pools use explicitly allocated available Operating income after expenses and existing obligations. The same money cannot also fund Satcoin rewards.

Network identity or a profile follow grants no spending authority. Use [the roadmap](/reference/roadmap), [Fcode Lab and FCOD](https://docs.fcode.ai/fcod) and the installed release's supported permissions.
