# Native signer policy templates

These deliberately inactive templates are review inputs. Fresh wallets remain
at their deny-all policy until an owner-confirmed policy installation succeeds.
Copying a template does not enable signing.

The Agent template permits exact native SOL and SPL transfers only after every
placeholder is replaced by a reviewed wallet identifier, destination, mint,
and positive raw-unit cap. Set the policy file to mode `0600` before using
`fased-signer-policy --initial-install`.

Every policy allowing an on-chain operation must include a `solana:native`
asset with per-transaction and daily caps of at least `6500000` lamports for
the signer-controlled fee and validated rent reserve. Native transfer caps
must cover both principal and this reserve.

The network template configures independent RPC endpoints. WEN financial
operations use their dedicated reviewed descriptors, admissions, and budgets;
there is no legacy Satcoin Mining or Vault bond starter policy.
