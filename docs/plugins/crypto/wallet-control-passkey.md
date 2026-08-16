---
summary: "Understand the optional Control UI account passkey and separate Vault approval device."
read_when:
  - You want to protect Control UI account actions
  - You are configuring manual Vault approval
title: "Wallet passkeys"
sidebarTitle: "Wallet passkeys"
---

# Wallet passkeys

Fased has two separate optional concepts. Neither is part of installation or
terminal wallet onboarding.

## Control UI account passkey

The **Control UI account passkey** lives under **Account Security**. It adds
WebAuthn protection to the web account and selected Gateway settings/actions.

It does not:

- create or unlock a wallet;
- affect Agent or Mining readiness;
- authorize signer execution by itself;
- replace a signer policy; or
- encrypt a recovery package.

Users may enable or skip it. Gateway login is not signer authorization.

## Vault approval device

A native Vault may optionally use a signer-owned approval device for exact
manual Vault reviews. The Vault's **Security** panel explains this separate
readiness requirement; it does not enroll the device through ordinary Gateway
JavaScript. Enrollment is a native signer-owner ceremony. On Hosting, run
`sudo /home/app/.fased/bin/fased-signer-owner webauthn-enroll` from the
provider root console. This signed, lifecycle-installed wrapper holds the
Hosting mutation lock, exposes only a private temporary Tailscale Serve path,
and restores the prior Serve configuration when the ceremony ends. It is
separate from the Control UI account passkey.

Agent and Mining do not receive a passkey prompt for automatic operations inside
their narrow typed policies. An Agent/Mining request outside policy is rejected
unless the owner separately enables an exact reviewed lane.

## Recovery passwords are different

The recovery password encrypts an exported recovery package with Argon2id and
authenticated encryption. It is entered directly into the native signer in the
terminal. It is not a passkey and never enters the Control UI.

Related:

- [Wallets](/plugins/crypto/wallet-page)
- [Self-hosted signer](/plugins/crypto/wallet-self-hosted)
- [Wallet CLI](/cli/wallet)
