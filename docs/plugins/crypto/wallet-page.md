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
- enter or replace one primary RPC;
- see public address, role, network, policy, backup, and signer readiness;
- choose the optional Default Agent wallet;
- attach the singleton Mining wallet;
- Receive, copy the address, or show a QR code;
- create role-appropriate Send requests; and
- Archive/Replace a wallet through guarded confirmation.

## Create a wallet

1. Choose **Create wallet**.
2. Enter a name and wallet ID.
3. Explicitly choose **Agent**, **Mining**, or **Vault**. No role is selected
   automatically.
4. Enter one primary Solana RPC.
5. Choose **Create wallet**.

The Go signer creates the key and returns only the public address. It verifies
the endpoint's live genesis hash, derives the official verification-only
witness, activates signer-owned role baseline v1, and returns the exact live
policy/network hashes and readiness.

The UI can create Mining when no active Mining wallet exists. Fased permits one
active Mining wallet. To replace it, stop Mining, settle claims/capital/funds,
verify backup and readiness, then use the typed Archive/Replace flow and create
the successor.

The browser does not import private keys. Use the terminal command documented
in [Wallet CLI](/cli/wallet); Local and Hosting return the same result.

## Wallet cards

Each card shows the information needed before funding or sending:

- permanent role and public Solana address;
- balance and Receive controls;
- signer key readiness;
- primary RPC/network readiness and version;
- signer policy state and acknowledged hash;
- Default Agent or Mining attachment; and
- backup guidance.

For a native wallet, open **Security** to replace the primary RPC. A draft is
cleared when you change wallets so an endpoint typed for one wallet cannot be
saved to another. The signer accepts a replacement only after pinned-genesis
verification.

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

An optional **Vault approval device** is shown only as separate guidance in
that Vault's Security panel. Enrollment is a native signer-owner ceremony, not
an ordinary Control UI operation. Local and Hosting operators use the native
wallet lifecycle from their terminal; the ordinary Gateway/browser route
cannot enroll signer credentials. Once enrolled, the signer can authorize exact
manual Vault reviews; it never changes Agent or Mining automation.

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
