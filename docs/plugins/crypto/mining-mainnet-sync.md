---
summary: "How Fased Agent receives official Satcoin mainnet program IDs after launch."
read_when:
  - You see the Mining page Sync control
  - You are preparing Fased Agent before Satcoin mainnet launch
  - You need to verify or manually set SAT runtime IDs
title: "SAT Mainnet Sync"
sidebarTitle: "Mainnet Sync"
---

# SAT Mainnet Sync

Fased Agent ships pre-launch without active Satcoin mainnet runtime IDs.

After the official Satcoin launch announcement, use **Sync** on the Mining page
before funding or starting mainnet mining.

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

## Pre-launch

Before launch:

- `config/sat-runtime.env` is intentionally empty
- the Mining page can be installed and opened
- mainnet mining should remain unavailable
- devnet or local testing requires explicit test IDs

Do not paste addresses from replies, screenshots, or direct messages.

## Launch notification

Wait for the official Satcoin launch notice from the public Satcoin docs and
the official announcement channels. Posts on X or Discord should point back to
the same docs, status page, and signed manifest.

Use this order:

1. open the Satcoin docs
2. check Mainnet status and Launch proof
3. confirm the official announcement points to those pages
4. click **Sync** in Fased Agent Mining
5. start with small mining capital only after Sync is green

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

Pre-launch releases keep `config/sat-runtime.env` empty. Later Fased Agent
releases may ship with the final mainnet IDs prefilled, but Sync remains the
safer path because it checks the live signed manifest.

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
