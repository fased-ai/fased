---
summary: "Permanent wallet roles, signer-owned baselines, and explicit automation grants."
read_when:
  - You are choosing an Agent, Mining, or Vault role
  - You are configuring policy or skill wallet authority
title: "Wallet roles and policies"
sidebarTitle: "Roles and policies"
---

# Wallet roles and policies

Choose the role before creating or importing a wallet. The signer records it
as immutable; use a different wallet when the purpose changes.

## Role matrix

| Role   | Normal purpose                                                         | Built-in role baseline                                                                | Additional authority                                                |
| ------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Agent  | Reviewed payments and approved Agent work                              | Reviewed SOL/SPL transfer to an exact reviewed destination, with positive signer caps | Explicit action/skill/Agent grants plus signer policy               |
| Mining | SAT capital, commit/reveal/settlement/claim/cleanup/ALT, and SAT sweep | Release-bound typed SAT actions plus reviewed owner movement                          | Verified SAT manifest, funding, and active singleton attachment     |
| Vault  | Reserve, bond, and federation authority                                | Manual reviewed SOL/SPL transfer only                                                 | Exact review and signer-owned approval; never background automation |

Agent and Vault may have multiple wallets. Exactly one Mining wallet may be
active. Display names are labels; risky requests use wallet IDs or
`@wallet:<walletId>` handles.

## New wallets are role-ready

Create, import, and recovery activate signer-owned role baseline v1 together
with one verified primary RPC. Readiness is authoritative only when the live
wallet role, public address, policy version/hash, baseline version, network
version/hash, and registry record agree.

Role-ready does not mean unlimited:

- Agent and Vault baselines permit reviewed owner transfers only to the exact
  reviewed destination under positive caps.
- Mining permits only release-bound typed SAT actions and reviewed owner
  movement; it is not a generic payment or skill wallet.
- Any missing operation, program, asset, destination, or positive cap remains
  denied.

Legacy wallets created under the former explicit deny-all policy stay deny-all
until the owner reviews the immutable role and selects **Activate role
baseline** once. Fased never expands them during migration, restart, or update.

## Default Agent is optional

Creating or importing an Agent wallet never silently makes it a fallback. The
operator may explicitly select one Agent wallet as **Default Agent wallet**.
Risky actions then use this precedence:

1. explicit wallet;
2. approved skill wallet override;
3. Agent assignment; and
4. Default Agent wallet.

Ambiguity or a missing selection fails closed. Mining and Vault cannot become
the Default Agent wallet.

## Skill wallet grants

Skills may use Agent wallets only. Installing a skill and granting wallet
authority are separate decisions. A mutating request must match the exact
approved skill/source, Agent role, wallet ID, chain, action, mint, amount,
slippage, autonomous mode, and schedule permission.

```bash
fased skills wallet grant reviewed-wallet-skill \
  --wallet-id agent \
  --actions quote,swap \
  --chain solana \
  --registry https://clawhub.com \
  --input-mint So11111111111111111111111111111111111111112 \
  --output-mint YOUR_ALLOWED_MINT \
  --max-amount 100000000 \
  --max-slippage-bps 50
```

Use `--registry local` only for reviewed local code. The signer policy remains
final and may reject an action even when the skill grant permits it.

## Policy changes

Before expanding authority:

1. verify wallet ID, role, and address;
2. read the live policy version/hash;
3. review the normalized operation/program/asset/destination/cap diff;
4. apply through the native owner/operator lifecycle;
5. verify the signer acknowledges the new version/hash; and
6. test with intentionally small working value.

The Gateway may request a tighter policy but cannot use its application socket
to expand authority. Corrupt, unsupported, stale, or conflicting policy fails
closed. Restart never resets signer caps or daily accounting.

## Passkeys and custody

The optional Control UI account passkey protects the web account; it is not
wallet readiness. Signer-owned approval for native reviewed actions is a
separate exact-transaction ceremony. Private keys and recovery passwords stay
in the native terminal/signer path and never cross the ordinary Gateway or
browser UI.

Keep funded balances near the maximum loss you intentionally accept. Stopping
an Agent or miner is not a custody lock; tighten signer policy and reconcile
unknown submissions after unexpected behavior.

## Related

- [Wallet CLI](/cli/wallet)
- [Wallet selection](/plugins/crypto/wallet-selection-contract)
- [Wallet operations and recovery](/plugins/crypto/wallet-production-flow)
- [Mining](/plugins/crypto/mining-page)
- [Skills](/tools/skills)
