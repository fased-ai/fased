# Fased official release trust

This directory contains public release-trust material only. Never place a
private key, seed, credential, access token, Wallet secret, or recovery secret
here.

## What the three roots do

[`root-v1/manifest.json`](root-v1/manifest.json) declares the owner-approved
2-of-3 Ed25519 root:

| Root   | Public-key ID                                                      |
| ------ | ------------------------------------------------------------------ |
| root-1 | `a5f07688f14ff3e7c5b61d8e7109522360851c3bffbcc277ce8241d7151b4d3a` |
| root-2 | `93614a5dc68035b1718455dbc43163dd62e71243ab496f961ecd7f23a607a971` |
| root-3 | `65e5a3b316f86ddacfefd042b2e06bf9320e2e170bef2053541556ae8ba3573b` |

These public keys identify who may change the definition of an official Fased
release. They are not developer SSH keys, GitHub accounts, Wallet keys, PR
approval keys, or keys that contributors use.

Any two roots authorize only rare trust-policy operations:

- establish the initial official release authority;
- change or revoke that authority;
- rotate a root key; or
- recover after compromise.

Root keys do not sign ordinary releases. There are no mandatory cloud, HSM, or
role-specific release keys.

## Ordinary development and release flow

The root policy authorizes this exact automatic release authority:

```text
repository:          fased-ai/fased
workflow:            fased-ai/fased/.github/workflows/hosted-runtime-release.yml
source ref:          refs/tags/v<exact-version>
self-hosted runners: denied
```

Normal work remains:

```text
developer opens PR
-> CI validates it
-> maintainer merges it
-> owner creates the exact immutable candidate tag
-> protected GitHub workflow builds and attests release assets
-> installer/updater verifies the offline GitHub attestation bundle
-> exact release metadata and artifact digests are verified
-> activation commits or rolls back transactionally
```

Contributors and forks never receive root authority. A fork can publish its own
artifacts, but the official installer and `fased update` reject them because
their repository or workflow identity does not match the root-approved policy.

End-user commands do not change. The one-curl installer and `fased update`
perform verification silently without asking users for release keys.

## Rare root-policy ceremony

The repository tools accept public keys and detached signatures; they never
need root private keys.

Build the initial unsigned policy request and exact canonical payload:

```bash
node scripts/build-lifecycle-root-request.mjs \
  --version 1 \
  --issued-at "YYYY-MM-DDTHH:MM:SS.000Z" \
  --expires-at "YYYY-MM-DDTHH:MM:SS.000Z" \
  --request "$HOME/fased-root-v1.request.json" \
  --payload "$HOME/fased-root-v1.payload"
```

Inspect the payload digest and sign the exact payload with any two separately
held roots:

```bash
openssl pkeyutl \
  -sign \
  -rawin \
  -inkey "/offline/path/to/root.private.pem" \
  -in "$HOME/fased-root-v1.payload" \
  -out "$HOME/fased-root-N.signature"
```

Finalize and verify the signed policy:

```bash
node scripts/finalize-lifecycle-root-metadata.mjs \
  --request "$HOME/fased-root-v1.request.json" \
  --signature "ROOT_KEY_ID_1=$HOME/fased-root-1.signature" \
  --signature "ROOT_KEY_ID_2=$HOME/fased-root-2.signature" \
  --output "$HOME/fased-lifecycle-root-v1.json" \
  --pin-output "$HOME/fased-lifecycle-root-v1.sha256"
```

The signed policy and its immutable digest are public. Private root material
remains outside the repository and ordinary release automation.
