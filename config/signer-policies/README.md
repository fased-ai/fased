# Native signer owner-policy templates

These files are deliberately inactive templates. Every `REPLACE_WITH_...` value
is invalid, so an unreviewed template cannot unlock a wallet. Copy one template
to a new owner-only file, set `walletId` to the canonical signer wallet ID
returned by native setup (lowercase with separators normalized to underscores,
not the friendly Gateway/registry ID; the template value is only the
conventional role name), replace every placeholder with an exact address or a
canonical positive raw-unit cap, review every line, then set the file to mode
`0600` before running
`fased-signer-policy --initial-install`.

Fresh signer-owned wallets remain at their version-1 deny-all policy until that
owner-confirmed command succeeds. Merely installing Fased or copying a template
does not enable signing.

Every policy that permits an on-chain operation must include a
`solana:native` asset whose `maxPerTx` and `maxDaily` are each at least
`5000000` lamports. The native signer reserves that fixed, signer-controlled
ceiling atomically for network fees and explicitly validated rent; for a native
SOL transfer, the principal and this reserve must fit inside the same cap.
Existing custom policies below that minimum intentionally become locked after
the signer-v2 upgrade. Review the new limit and install a new version explicitly
with `fased-signer-policy`; installation and update never widen it automatically.

- Agent permits only typed native SOL and exact-mint SPL transfers to listed
  destinations. Direct SPL transfer requires pre-existing canonical source and
  destination token accounts; it cannot spend SOL to create an associated token
  account and therefore does not grant the Associated Token program by default.
- Mining permits program-bound typed SAT mining actions. The native signer
  forces generic SOL/SAT transfers through reviewed authorization for a Mining
  wallet; it never treats them as autonomous mining actions. Exact SAT codecs
  that genuinely use associated-token-account instructions retain that program
  grant.
- Vault operations always require signer-owned reviewed authorization. The
  starter omits Jupiter and Trigger permissions; add them only after separately
  reviewing their exact semantic policy programs, assets, destinations, and
  caps.

Receiving SOL or SAT does not require a signing permission. Do not add a
receive-only address as a destination unless the signer should also be allowed
to send to it.
