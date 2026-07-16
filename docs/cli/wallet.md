---
summary: "Set up Solana wallets, inspect wallet status, and manage local wallet policy from the CLI."
read_when:
  - You want to create or import a wallet from the CLI
  - You need wallet status, signer diagnostics, or policy automation
title: "wallet"
---

# `fased wallet`

Manage wallet setup, keystore state, local signer health, custody locks, wallet
roles, and policy status.

Browser management surface: **Wallets**. Wallet creation and import use
onboarding or the guarded CLI. The browser page manages configured wallet
addresses, funding, balances, approvals, access policy, and skill grants;
the browser page does not accept a private key directly.

## Common commands

```bash
fased wallet setup --chain solana
fased wallet status
fased wallet signer doctor --json
```

`wallet setup` supports Solana wallet creation/import, role selection, embedded
keystore, local-signer, and Turnkey modes depending on flags and installed
components. Use it to import separate Phantom-exported Agent, Mining, and Vault
accounts. Never provide a seed phrase or recovery phrase.

### Turnkey provider

Turnkey setup needs a dedicated API user, the organization and policy reference
you expect Turnkey to evaluate, and a Solana RPC URL:

```bash
fased wallet setup --mode turnkey \
  --turnkey-api-public-key "$TURNKEY_API_PUBLIC_KEY" \
  --turnkey-api-private-key "$TURNKEY_API_PRIVATE_KEY" \
  --turnkey-organization-id "$TURNKEY_ORGANIZATION_ID" \
  --turnkey-policy-id "$TURNKEY_POLICY_ID" \
  --rpc-url "$FASED_WALLET_SOLANA_RPC_URL"
```

Avoid putting the private key argument in shell history. Interactive setup or
the encrypted provider-credential UI is safer. The configured policy ID is a
readiness and audit reference. Fased checks that it resolves to an `ALLOW`
policy with a non-empty condition, but that does not prove the selector applies
to this API user. Turnkey's organization policy engine makes the authorization
decision for every signing activity. Configure the policy so its condition
applies to this dedicated API user and permits only the intended wallets,
Solana signing activities, limits, and destinations. Fased builds and simulates
typed SOL/SPL transfers, persists the immutable review, verifies the returned
transaction has the exact reviewed message, and broadcasts it once with
automatic RPC retries off.

Privy remains unavailable. Saving Privy credentials does not enable wallet
creation, balance lookup, or signing.

### Hardware-backed Vault in the browser

Open **Wallets** in Fased Control and choose **Attach hardware Vault**. Select a
Solana Wallet Standard account backed by the hardware device you intend to use.
Fased records only the public address; browser wallet discovery cannot itself
prove that an account is hardware-backed.

The Gateway also needs `FASED_WALLET_SOLANA_RPC_URL` (or the equivalent scoped
Solana RPC setting) before it can prepare or verify a hardware Vault send.

Hardware Vault sends are manual and browser-only: Fased builds and simulates the
typed SOL/SPL transfer, the connected wallet signs the exact short-lived review,
and the Gateway verifies the message and signature before a single broadcast.
Changed, expired, reused, or wrong-account signatures are rejected. Keep the
same wallet account and Solana network selected through approval.

## Keystore

```bash
fased wallet keystore init --wallet-id agent --role agent
fased wallet keystore import --wallet-id agent --private-key "$FASED_WALLET_PRIVATE_KEY"
fased wallet keystore status
fased wallet keystore validate
```

For Solana import, the preferred human format is a base58 64-byte private key.
The importer also accepts a Solana JSON byte array, base64/base64url, or hex.
Keep private keys out of shell history. Prefer environment variables, files, or
the browser setup flow when possible.

## Policy and signer operations

```bash
fased wallet status --json
fased wallet policy profile manual-owner
fased wallet custody-lock --wallet agent
```

Additional subcommands exist for custody locks, provider configuration,
keystore export/import, signer doctor, broker/serve flows, inbound polling, and
role assignment. Run `fased wallet --help` for the full command surface.

Optional adapter configuration, including limit-order support, is kept out of
the common path. Enable those features only after wallet policy and funding
limits are clear.

Security boundaries:

- Agent wallets are the only wallet role skills can request
- Mining wallets and vault wallets are not granted to skills
- Skill wallet access still requires explicit **Wallets > Skill Grants** review
  or `fased skills wallet grant`

Related:

- [Wallets](/plugins/crypto/wallet-page)
- [Wallet security](/plugins/crypto/wallet-autonomous-security)
- [Skills CLI](/cli/skills)
