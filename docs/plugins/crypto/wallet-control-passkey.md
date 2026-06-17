---
summary: "How to enable Wallet Control Passkey, approve sends, and operate split-key wallet security deliberately."
read_when:
  - You want to turn on passkey-gated wallet approval
  - You need the operator flow for send approval, unlock, recovery, or device-share handling
title: "Wallet Control Passkey"
sidebarTitle: "Wallet passkey"
---

# Wallet Control Passkey

Wallet Control Passkey is the approval and ceremony layer for wallet-sensitive actions in Fased.

Use it for:

- send approvals
- wallet-control changes
- wallet security setup
- unlock
- recovery
- device-share and second-device changes

It is the first approval-control step before you rely on split-key wallet security.

## What it protects today

Current behavior is:

- ordinary user sends create an approval request first
- passkey is used on `Approve`, not on `Create Approval Request`
- wallet security actions require Wallet Control Passkey before they proceed

That means passkey is not just cosmetic login decoration.
It is already part of the wallet-control plane.

## Browser and origin requirements

Passkeys need a secure browser context.

Practical rule:

- use HTTPS
- or use `http://localhost:18789` on the gateway host

If you are browsing from a different machine over plain HTTP, passkey behavior may fail even when the wallet setup itself is healthy.

## Step 1: enable passkey approval

In the Wallets page:

1. open **Wallets**
2. open the `Access` tab
3. find `Wallet Control Passkey`
4. click `Enable passkey approval`

After that, Fased is in passkey mode but still not ready until a passkey is enrolled.

## Step 2: enroll the first passkey

Still in `Wallet Control Passkey`:

1. optionally set a label
2. click `Enroll passkey`
3. complete the browser's passkey ceremony

Once enrolled, Wallet Control Passkey becomes the normal gate for:

- approving sends
- changing wallet controls
- setting up split-key security
- unlock and recovery actions

## Step 3: use passkey in the send flow

The current send flow is:

1. open the send modal
2. choose source wallet, chain, amount, and destination
3. click `Create Approval Request`
4. review the pending request
5. click `Approve`
6. complete passkey verification if enabled
7. let Fased execute and log the send

This matters because the passkey is attached to approval, not to typing the form.

## Step 4: turn on wallet security

For Agent and Vault wallets, you can then enable split-key custody.

Current operator flow:

1. select the wallet
2. go to its security section
3. initialize split-key security
4. export or print the recovery share
5. decide whether this browser may keep an encrypted device share

After setup:

- the wallet is locked by default
- unlock requires Wallet Control Passkey plus device or recovery share

Mining keeps its own Satcoin-only controls instead of mirroring the full Agent or
Vault security panel.

## Device share and recovery share

The current split-key model has two operator responsibilities:

- device share
- recovery share

Device share:

- belongs on a trusted browser or second device
- can be exported for second-device setup
- should not be stored together with the recovery share

Recovery share:

- is the offline backup
- should be downloaded, printed, or otherwise stored offline
- should stay separate from both the host and any device share

If you lose the browser-stored device share, the recovery share is the thing that gets you back in.

## Encrypted browser storage

Some browsers can keep the current device share in encrypted browser storage.

That is helpful, but it is not a replacement for the recovery share.

Practical rule:

- encrypted browser storage is convenience for this client
- offline recovery share is the real backup

If the browser or authenticator does not support the required passkey storage path, keep the device share manual on that client.

## Unlock, recovery, and second device

Current operator model:

- `unlock` opens a signing window for a secured wallet
- `recover` rotates the wallet onto a new device share and new recovery share
- `enroll device` creates a second-device handoff
- `revoke device` removes a stale or lost device share

Best practice:

- unlock only when you intend to sign
- recover immediately if a device share is lost or compromised
- after recovery, export the new recovery share right away

## Best practices

- enroll at least one passkey before turning on wallet security
- keep passkey, device share, and recovery share as three separate concerns
- keep the recovery share offline
- do not rely on one browser profile as your only recovery path
- do not remove the last passkey while secured wallets still depend on it

## What this guide does not claim

Wallet Control Passkey is already real for approval and ceremony.

A passkey approval gate is not, by itself, complete at-rest custody protection for every wallet.

For the deeper operator model, see:

- [Autonomous wallet security](/plugins/crypto/wallet-autonomous-security)
- [Autonomous wallet sessions](/plugins/crypto/wallet-autonomous-sessions)

## Related docs

- [Wallet](/plugins/crypto/wallet-page)
- [Self-hosted wallet signer](/plugins/crypto/wallet-self-hosted)
- [Wallet operations and security](/plugins/crypto/wallet-production-flow)
- [Mining](/plugins/crypto/mining-page)
