---
title: "Fased and Satcoin Mining"
summary: "Optional research and bounded strategies for WEN Asset Mining."
---

**Mine Satcoin. Compete for BTC.** WEN is an Asset Mining platform from Fcode Lab. Satcoin Mining is its first product; **Satcoin** is the asset name. SAT is the short form used for quantities.

Participants allocate SOL across BTC price ranges in ten-minute mining rounds. BTC's measured movement determines accuracy. Committed capital × accuracy determines each entry's share of released fresh BTC rewards and unlocked SAT. More capital on a range increases the share at equal accuracy; it does not make that BTC outcome more likely. Multi-range allocation is permitted.

The WEN app is the primary mining experience. Fased is an optional agent for research, bounded strategies and review.

<Note>The new Satcoin Mining integration is in development. This guide describes approved product rules and planned Fased support, not an available financial release.</Note>

![Satcoin bootstrap: zero supply; SAT awards split 50/50; deductions and fees split 90/10. Both 50 net SOL and 15,000 LP SAT must accumulate before accepted rounds finish and the SAT/SOL pool activates.](/assets/diagrams/satcoin-bootstrap.svg)

## Bootstrap and graduation

New Satcoin supply starts at zero. Bootstrap divides earned SAT **50% miners / 50% LP** and routes **90% of actual deductions plus exact-entry fees to LP SOL / 10% Operating**. Principal recovery is unchanged. Bootstrap has no ordinary BTC, daily-prize or staking distributions.

The **8× boost is limited to 60,000 gross SAT** inside the **1,500,000 annual / 30,000,000 lifetime** totals. Mining continues without a calendar expiry until settled LP funds reach **50 net SOL and 15,000 SAT**. Accepted rounds finish before all accounted balances seed the official **SAT/SOL** pool. Earned SAT can begin its 24-hour stake maturity during bootstrap. After verified LP activation, normal mining does not require eligible stakers. If the fixed snapshot has none, that round’s staking allocation returns in SOL to its original forfeiture contributors, proportional to their actual deductions; later stakers cannot claim it.

Bootstrap advances the annual allowance; the remaining schedule is reduced as necessary, with reservations counted once and no boost reset. Extra liquidity later uses received treasury funds, without new SAT minting. The opening price comes from actual deposited balances and available market depth. See [the full launch rules](https://docs.satcoin.app/bootstrap).

## What a round returns

- Exact-range entries return **99% of principal**, after the 1% fee under the current phase.
- Incorrect entries deduct **5%–10%**, returning **90%–95%** of principal. Eligible near misses also receive partial fresh rewards.
- Released BTC and SAT are separate from returned principal. Network and conversion costs must be displayed separately.
- Invalid observations void the round without mining deductions or SAT issuance. Pending conversions are not yet claimable BTC.

In normal mining, actual forfeitures fund 74% miners / 1% daily competition / 10% staking / 10% Operating / 5% treasury, plus the separate exact-entry fee to Operating. The normal treasury allocation divides **50% to BTC holdings, 25% to USDC-funded locked SAT purchases and 25% to SOL-funded balanced SAT/SOL additions**. The liquidity budget covers both assets and cannot use locked SAT or participant claims. Bounded purchases/additions can be skipped when execution conditions fail. Market purchases do not mint SAT or promise a price floor.

SAT starts at zero with **30,000,000 cumulative lifetime / 1,500,000 total annual** limits, counting bootstrap/miner/LP awards and unresolved reservations. The current phase-specific ceiling, 5 SOL capital unlock and highest credit determine release. Staking and market buying do not mint SAT.

## The planned WEN desk

- Review BTC movement, the five published ranges, entry/reveal deadlines and conditional payouts.
- Compare one-range and multi-range strategies, including the proposed allocation's effect on its own reward share.
- Set total, daily and per-round SOL limits, maximum unsettled exposure, skip conditions and expiry.
- Track returned principal, pending rewards, received BTC, SAT and actual execution costs separately.
- Collect rewards or change stakes only under separate supported permissions. Pause future entries without abandoning committed settlement or recovery.

Fased follows the same capital-and-accuracy rules as manual participation. Copying a strategy needs an explicit budget and permissions; following a profile alone grants neither. Sealed entries revealed after commitment closes cannot be copied into that same round. Daily rankings are wallet/team capital competition, including permitted cooperation, not proof of unique people or guaranteed skill.

## Mine, trade, stake and compete

**Mine** allocates SOL through round rules. **Trade SAT** buys or sells existing Satcoin. **Stake** receives eligible activity-funded BTC. **Daily competition** uses its separately accounted share of forfeitures. A BTC price input does not open an actual BTC position or make SAT BTC-backed.

Read [WEN automation](/wen/automation) for agent limits, [WEN documentation](https://docs.wen.network) for the product rules and [Satcoin documentation](https://docs.satcoin.app) for the asset. This guide does not grant spending authority.

## Asset and phase identity

Every future strategy, preview, receipt and permission must bind the admitted network, program, asset/economy, mint, terms and permitted phases. Fased must show bootstrap SAT/LP contributions separately from normal BTC rewards, and stop future unapproved spending at a phase transition. It must not retarget another asset or reuse prior permissions silently. WEN and Fased consume the same canonical definitions; this guide does not implement or activate those routes.
