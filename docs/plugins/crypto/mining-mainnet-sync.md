---
summary: "How Fased Agent receives official Satcoin mainnet IDs after launch."
read_when:
  - You see the Mining page Sync control
  - You are preparing Fased Agent before Satcoin mainnet launch
  - You need to verify or manually set SAT mainnet IDs
title: "SAT Mainnet Sync"
sidebarTitle: "Mainnet Sync"
---

# SAT Mainnet Sync

Fased Agent ships pre-launch without active Satcoin mainnet IDs.

Before launch, use **Sync** to confirm that Satcoin still reports `not_live`.
After the official Satcoin launch announcement, use the same **Sync** action
before depositing miner capital or starting mainnet mining.

## Where to run Sync

Use either path:

- **UI:** open **Mining**, then press **Sync** in the Mining toolbar.
- **CLI:** run `fased sat sync-mainnet` or
  `fased sat sync-mainnet --json`.

The UI and CLI call the same verified sync operation.

## Sync is not a Fased update

`fased update` installs a newer Fased application release. Sync fetches,
verifies, and applies the four official Satcoin mainnet IDs.

To preserve a Sync-only mainnet day, install the approved Sync-capable Fased
release during pre-launch preparation. That release must already contain the
public key used to verify the official manifest. When mainnet goes live, no
second application release is needed just to deliver the final IDs: press
**Sync** or run `fased sat sync-mainnet`.

## What Sync does

The Mining page Sync control checks the official Satcoin mainnet address
manifest:

```text
https://satcoin.app/.well-known/sat-mainnet-addresses.json
```

When the manifest is still `not_live`, Fased Agent stays unsynced and mainnet
mining remains blocked.

When the manifest is `live`, Fased Agent verifies the published hash and
signature, then writes the official IDs into:

```text
config/sat-runtime.env
```

The Mining page should only show a connected mainnet state after that signed
manifest verifies.

The signature is checked with an Ed25519 public key embedded in the Fased
release. This is a project release trust key, not a user's Solana wallet public
key. Mainnet status can be checked before any wallet exists. If a live manifest
appears but the installed release has no trusted key, Fased fails closed and
asks the user to update; it does not accept the manifest or start mining.

The environment-key override exists for controlled launch rehearsals and key
rotation tests. Normal users should never paste or configure a manifest key.

Sync does not create or import a wallet, ask `fased-signerd` to sign anything,
move SOL, deposit miner capital, or start mining. It can check official status
before a wallet exists. Wallet setup and funding remain separate steps.

## Pre-launch

Before launch:

- `config/sat-runtime.env` is intentionally empty
- the Mining page can be installed and opened
- mainnet mining should remain unavailable
- devnet or local testing requires explicit test IDs
- users should install the approved Sync-capable Fased release
- **Sync** should return `not_live` without changing wallet or mining state

Do not paste addresses from replies, screenshots, or direct messages.

## Launch notification

Wait for the official Satcoin launch notice from the public Satcoin docs and
the official announcement channels. Posts on X or Discord should point back to
the same docs, status page, and signed manifest.

Use this order:

1. open the Satcoin docs
2. check Mainnet status and Launch proof
3. confirm the official announcement points to those pages
4. open **Mining** and click **Sync**, or run `fased sat sync-mainnet`
5. confirm Sync verified one complete four-ID tuple
6. run readiness
7. deposit small miner capital only after Sync is green

## Manual verification

Manual editing is only for recovery, review, or explicit test environments. If
you need to check by hand, compare all four values against the official
Satcoin manifest and docs:

```text
FASED_SAT_PROGRAM_ID=
FASED_SAT_BOND_PROGRAM_ID=
FASED_SAT_MINT_ADDRESS=
FASED_SAT_MINT_PROGRAM_ID=
```

All four values must come from the same signed manifest. Do not mix a mint from
one source with program IDs from another source.

After editing the file, restart the Gateway and re-open the Mining page.

## Post-launch releases

Pre-launch releases keep `config/sat-runtime.env` empty. The approved
pre-launch release carries the manifest verification public key, not the final
mainnet IDs. Sync remains the public activation path because it checks the live
signed manifest and applies one verified four-ID tuple.

## Read next

<Columns>
  <Card title="Mining" href="/plugins/crypto/mining-page" icon="pickaxe">
    Return to the Mining page guide.
  </Card>
  <Card title="Mining troubleshooting" href="/plugins/crypto/mining-troubleshooting" icon="circle-help">
    Diagnose blocked sync, RPC, readiness, claim, and cycle issues.
  </Card>
  <Card title="Satcoin docs" href="https://docs.satcoin.app/mainnet-status" icon="badge-check">
    Check the public mainnet status page.
  </Card>
</Columns>
