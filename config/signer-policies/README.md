# Native signer owner-policy templates

These files are deliberately inactive templates. Every `REPLACE_WITH_...` value
is invalid, so an unreviewed template cannot unlock a wallet. Copy one template
to a new owner-only file, replace every placeholder with an exact address or a
canonical positive raw-unit cap, review every line, then set the file to mode
`0600` before running `fased-signer-policy --initial-install`.

Fresh signer-owned wallets remain at their version-1 deny-all policy until that
owner-confirmed command succeeds. Merely installing Fased or copying a template
does not enable signing.

- Agent permits only typed native SOL and exact-mint SPL transfers to listed
  destinations.
- Mining permits program-bound typed SAT mining actions. The native signer
  forces generic SOL/SAT transfers through reviewed authorization for a Mining
  wallet; it never treats them as autonomous mining actions.
- Vault operations always require signer-owned reviewed authorization. The
  starter omits Jupiter and Trigger permissions; add them only after separately
  reviewing their exact semantic policy programs, assets, destinations, and
  caps.

Receiving SOL or SAT does not require a signing permission. Do not add a
receive-only address as a destination unless the signer should also be allowed
to send to it.
