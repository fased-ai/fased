---
title: "WEN automation"
summary: "Bounded Satcoin Mining strategies with the same rules as manual entries."
---

<Note>Planned integration. Use only actions explicitly supported by your installed release.</Note>

Start with research. Before enabling a financial action, decide:

- Which wallet, BTC ranges and SOL budget it can use.
- The per-round, daily and total spending limits, minimum awards and expiry.
- The permitted one-range or multi-range strategy, maximum unsettled exposure, conversion costs and slippage limits.
- Which claims, stake changes, withdrawals or other actions are allowed.
- When it must stop, pause future entries or ask you.

Permission to claim a reward is not permission to trade, borrow or move other funds. Future products will need their own permissions.

For example, a planned session could authorize 1 SOL in total, at most 0.01 SOL per round and 0.25 SOL per day, for seven days, without automatic top-ups. Depositing the budget does not spend it all. Entries that cannot meet the selected funding and user limits leave unused funds unspent; accepted pending work must settle or recover under its original terms.

Track available funds, pending entries, earned rewards and staked principal separately. SAT staking earns eligible BTC, not newly minted SAT. A pending BTC purchase is not yet claimable BTC, and an unresolved transaction must be reconciled before another attempt.

The strategy uses the same capital × accuracy weights as manual Satcoin Mining. Exact-range entries pay the 1% fee; incorrect entries have 5%–10% deductions and may earn partial rewards. Follow the [current product rules](/wen/index), not the retired physical-site or Bond workflows.

Before commitment, display historical or estimated crowding rather than pretending sealed selections are public. A payout preview must include the proposed entry and distinguish conditional rewards from received assets. Published ranges cannot change after entry; the agent cannot cancel accepted spending after seeing the outcome.

Copying authorizes only future actions within the selected mandate. A profile follow is informational. Converting claimed BTC, trading SAT or reinvesting paid proceeds requires its own supported permission. There is no automatic top-up or stake increase after a loss.

Review completed and pending transactions before changing a strategy. If a result is uncertain, check its status before retrying. Stopping future activity does not reverse a completed transaction.

Fased runs on your machine or server. You manage its availability and any model, hosting or service costs. Its advantage is analysis and control, not privileged access to WEN.

See [wallet safety](/guide/wallets) before authorizing financial automation.
