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

Browser equivalent: **Wallets**. Normal users should use the browser page for
funding, balances, approvals, access policy, and skill grants. Use the CLI for
headless setup, recovery, or automation.

## Common commands

```bash
fased wallet setup --chain solana
fased wallet status
fased wallet signer doctor --json
```

`wallet setup` supports Solana wallet creation/import, embedded keystore,
local-signer, and Turnkey modes depending on flags and installed components.

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
