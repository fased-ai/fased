---
summary: "Set up Solana wallets, inspect wallet status, and manage local wallet policy from the CLI."
read_when:
  - You want to create a signer-owned wallet or configure a supported provider
  - You need wallet status, signer diagnostics, or policy automation
title: "wallet"
---

# `fased wallet`

Manage signer-owned wallet setup, supported providers, native signer health,
wallet roles, and policy status.

Browser management surface: **Wallets**. The browser page manages configured
public addresses, funding, balances, approvals, access policy, and skill grants.
It never accepts a private key, seed phrase, recovery phrase, keystore
passphrase, or signer control-socket command.

## Common commands

```bash
fased wallet setup --chain solana
fased wallet setup --mode local-signer-create --chain solana \
  --wallet-id agent --role agent --rpc-url https://your-solana-rpc.example
fased wallet status
fased wallet signer doctor --json
```

`wallet setup` creates a new key inside the native Go signer and returns only
its public address, or configures Turnkey/Alchemy provider metadata. A new
native wallet receives one permanent role (`agent`, `mining`, or `vault`) and a
deny-all policy. Creation alone cannot send funds.

`--mode local-signer-import` only prints guarded native-admin guidance. Import
does not run inside Node, the Gateway, onboarding, or the browser. Never put a
private key or passphrase in a Fased CLI option, environment variable, config
file, chat, or browser form.

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
policy with a non-empty condition. Because Turnkey read queries are not
policy-enforced, that probe alone does not prove signing authority. On every
reviewed signature, Fased fetches the exact completed activity's policy
evaluations and requires `OUTCOME_ALLOW` for the configured policy ID before
broadcast. Configure the policy so its condition applies to this dedicated API
user and permits only the intended wallets, Solana signing activities, limits,
and destinations. Fased builds and simulates typed SOL/SPL transfers, persists
the immutable review, verifies the returned transaction has the exact reviewed
message, and broadcasts it once with automatic RPC retries off.

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

## Create and import boundaries

The embedded Node keystore and its `wallet keystore ...` commands are retired.
They fail closed and exist only to direct previous installations through a
one-way migration. There is no supported `FASED_WALLET_PRIVATE_KEY` flow.

For a Local install, an existing Solana CLI keypair may be imported only by the
same OS user that owns the native signer control socket. Keep the input file
owner-only and stream it on stdin:

```bash
chmod 600 /absolute/path/to/solana-keypair.json
"$HOME/.fased/bin/fased-signerd" admin wallet import \
  --control-socket "$HOME/.fased/wallet/local-signer-control.sock" \
  --wallet-id agent \
  --locked-role agent \
  < /absolute/path/to/solana-keypair.json
```

On Hosting, the `app` account cannot reach that control socket and has no signer
sudo access. Import only from a provider root console, using the fixed
root-installed signer binary as the dedicated signer user:

```bash
chmod 600 /root/solana-keypair.json
/usr/sbin/runuser -u fased-signer -- \
  /opt/fased/signer/fased-signerd admin wallet import \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id agent \
  --locked-role agent \
  < /root/solana-keypair.json
```

Use `--locked-role mining` only for the SAT Mining wallet and
`--locked-role vault` only for a reviewed Vault. The role cannot later be
changed by the Gateway. Delete the source keypair securely after you have
verified the signer-owned public address and your independent recovery copy.
Legacy encrypted Fased keystores use the native
`fased-signerd admin wallet import-legacy` command with owner-only keystore and
passphrase files; run `fased wallet setup --mode local-signer-import` to print
the exact installed guidance.

## Policy and signer operations

```bash
fased wallet status --json
fased wallet signer doctor --json
fased wallet policy profile manual-owner
```

The `wallet policy profile` command configures Gateway/UI behavior; it does not
widen a native signer policy. Native signer policy is the final authority and
must be acknowledged by its exact version/hash. For Local installs use the
owner-only launcher installed beside the signer. For Hosting, open a provider
root console and use `/usr/local/sbin/fased-signer-policy`; the `app` account
cannot run it. Review every operation, program, mint, destination, and positive
per-transaction/daily cap before funding the wallet.

Run `fased wallet --help` for provider configuration, signer doctor, inbound
polling, canary checks, and role metadata. `wallet signer serve`, Gateway key
rotation, custody-lock, broker, embedded-keystore import/export, and raw signing
are not supported production paths.

Optional adapter configuration, including limit-order support, is kept out of
the common path. Enable those features only after wallet policy and funding
limits are clear.

Jupiter Trigger requires an additional signer-owned API key. Do not pass it to
`fased wallet`, onboarding, Gateway config, or `FASED_JUPITER_API_KEY`; install
it from stdin with `fased-signerd admin jupiter api-key-install` as documented
in [Self-hosted wallet signer](/plugins/crypto/wallet-self-hosted#signer-owned-jupiter-trigger-credential).

Security boundaries:

- Agent wallets are the only wallet role skills can request
- Mining wallets and vault wallets are not granted to skills
- Skill wallet access still requires explicit **Wallets > Skill Grants** review
  or `fased skills wallet grant`

Related:

- [Wallets](/plugins/crypto/wallet-page)
- [Wallet security](/plugins/crypto/wallet-autonomous-security)
- [Skills CLI](/cli/skills)
