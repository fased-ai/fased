---
summary: "Create and manage Agent, Mining, and Vault wallets in the Control UI."
read_when:
  - You are using Wallets for the first time
  - You want addresses, RPC, readiness, policy, Receive, Send, or Mining attachment
title: "Wallets"
sidebarTitle: "Wallets"
---

# Wallets

**Control UI → Wallets** is the normal post-install wallet surface for Local
and Hosting.

Use it to:

- create Agent, Mining, or Vault wallets;
- enter or replace one RPC;
- copy the wallet handle or public address and open the address explorer;
- see role, balance, policy, and signer readiness;
- choose the optional Default Agent wallet;
- attach the singleton Mining wallet;
- Receive, copy the address, or show a QR code;
- create role-appropriate Send requests; and
- Archive/Replace a wallet through guarded confirmation.

## Create a wallet

1. Choose **Create wallet**.
2. Optionally enter a display name. Blank names become **Agent**, **Agent 2**,
   **Vault**, **Vault 2**, or the singleton **Mining**.
3. Choose **Agent**, **Mining**, or **Vault**.
4. Enter one Solana RPC.
5. Choose **Create wallet**.

Fased generates the permanent internal wallet ID. The resulting user-facing
handle is `@wallet:<id>`, such as `@wallet:agent-2`; use that handle in Send,
chat, tasks, skills, and Agent routing. Do not enter or invent a wallet ID in
the browser form.

The Go signer creates the key and returns only the public address. It verifies
that the endpoint is a Solana RPC, records its network, activates the built-in
role baseline, and returns readiness. A failed lifecycle creates no partial
wallet.

The UI can create Mining when no active Mining wallet exists. Fased permits one
active Mining wallet. To replace it, stop Mining, settle claims/capital/funds,
verify backup and readiness, then use the typed Archive/Replace flow and create
the successor.

The browser does not import private keys. Use the terminal command documented
in [Wallet CLI](/cli/wallet); Local and Hosting return the same result.

## Wallet cards

Each card shows:

- display name and permanent role;
- shortened public address with reveal, copy, and explorer controls;
- copyable `@wallet:<id>` handle and real receive QR;
- balance and Send;
- optional Agent/Mining routing; and
- Settings for RPC, policy, and advanced archive controls.

Open **Settings** to see RPC status. The stored URL is masked; use copy when you
need the exact value or edit to enter another provider. Fased verifies that the
replacement responds as Solana and remains on the wallet's current network.
Saving it updates the wallet without restarting the Gateway.

## Roles

- **Agent:** bounded hot-wallet actions for the agent, Marketplace, scheduled
  work, and explicitly granted wallet-capable skills.
- **Mining:** singleton SAT operations, fees, capital, claims, and reviewed
  sweeps only.
- **Vault:** manual-only reserve/bond role.

Roles are not editable after signer creation. Create a successor with the
required role instead.

## Readiness and Send

New native wallets are role-ready for their built-in reviewed or typed role
baseline. **Send** remains disabled whenever the key, RPC/network, exact signer
policy, requested destination, or positive cap is not ready for that operation.
The UI must not treat Gateway login or a public RPC response as signer
authorization.

A manual Send flow is:

1. choose the exact source wallet;
2. enter the destination and amount;
3. review simulation, decoded intent, policy hash, caps, and expiry;
4. approve through the role's permitted authorization lane; and
5. let the signer execute and durably reconcile the result.

Agent and Mining automatic operations do not prompt for a passkey when they are
inside their narrow signer policy. Work outside that policy is rejected unless
the owner has separately enabled an exact reviewed lane. Vault remains
manual-only.

## Account Security and Vault approval

The optional **Control UI account passkey** appears under **Account Security**.
It protects the web account. It does not create, unlock, or make Agent/Mining
wallets ready.

Vault sends always require an explicit review. They work with the authenticated
Control UI session when no optional signer approval device is enrolled. If an
operator enrolls a signer-owned approval device through the native terminal
ceremony, the signer also requires that device for the exact reviewed action.
This never changes Agent or Mining automation.

## Recovery

Wallets created during terminal onboarding can create an encrypted recovery
package immediately. Later Local and Hosting recovery export/restore and
advanced raw export use the same native terminal commands. The browser never
handles a recovery password or plaintext key.

For a wallet created later in the Control UI, the UI shows backup readiness but
does not offer encrypted or raw export until a separate signer-owned ceremony
exists. Do not fund beyond your risk limit without a tested signer-state/master
key backup or native recovery package.

## Archive/Replace

Archive requires the exact wallet ID. Mining replacement first stops new work,
proves no live/recoverable work or funds, writes encrypted recovery material,
tightens the old policy, records an irreversible signer retirement tombstone,
and only then moves runtime assignment to a distinct role-ready successor. A
retired wallet ID cannot return through normal setup.

Related:

- [Wallet CLI](/cli/wallet)
- [Self-hosted signer](/plugins/crypto/wallet-self-hosted)
- [Solana RPC setup](/plugins/crypto/wallet-rpc-setup)
- [Mining](/plugins/crypto/mining-page)
