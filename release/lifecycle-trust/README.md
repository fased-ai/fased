# Fased lifecycle release trust

This directory contains public release-trust material only. Never place a
private key, seed, cloud credential, access token, generated GitHub credential
file, or recovery secret here.

## Root role

[`root-v1/manifest.json`](root-v1/manifest.json) declares the owner-approved
2-of-3 Ed25519 root:

| Root   | Public-key ID                                                      |
| ------ | ------------------------------------------------------------------ |
| root-1 | `a5f07688f14ff3e7c5b61d8e7109522360851c3bffbcc277ce8241d7151b4d3a` |
| root-2 | `93614a5dc68035b1718455dbc43163dd62e71243ab496f961ecd7f23a607a971` |
| root-3 | `65e5a3b316f86ddacfefd042b2e06bf9320e2e170bef2053541556ae8ba3573b` |

Root private keys remain offline, independently held, and absent from release
automation. Any two roots authorize initial metadata and trust-policy changes.
Root keys do not sign ordinary releases.

## Delegated release roles

Normal release automation uses one distinct HSM-backed Ed25519 key for each
role:

```text
application
beta
controller
dependencies
platform
signer
snapshot
stable
timestamp
```

Do not reuse one delegated key across roles. Pin an explicit asymmetric key
version; asymmetric keys have no implicit primary version. Rotate a delegated
key by publishing new root metadata before disabling its prior version.

The recommended automation boundary is:

```text
GitHub protected release environment
-> short-lived GitHub OIDC identity
-> narrowly conditioned cloud workload identity
-> role-specific HSM signing permission
-> detached signature
-> local signature and public-key verification
```

No long-lived cloud service-account key belongs in GitHub.

## Google Cloud HSM provisioning

Google Cloud KMS supports HSM-backed `EC_SIGN_ED25519` keys. Provisioning is an
owner cloud-account operation:

```bash
export PROJECT_ID="replace-me"
export LOCATION="us-central1"
export KEY_RING="fased-lifecycle-release"

gcloud config set project "$PROJECT_ID"
gcloud services enable \
  cloudkms.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com
gcloud kms keyrings create "$KEY_RING" --location="$LOCATION"

for role in \
  application beta controller dependencies platform signer snapshot stable timestamp; do
  gcloud kms keys create "fased-lifecycle-$role" \
    --location="$LOCATION" \
    --keyring="$KEY_RING" \
    --purpose=asymmetric-signing \
    --default-algorithm=ec-sign-ed25519 \
    --protection-level=hsm
done
```

Export only public key version 1:

```bash
install -d -m 0700 "$HOME/fased-delegated-public"
for role in \
  application beta controller dependencies platform signer snapshot stable timestamp; do
  gcloud kms keys versions get-public-key 1 \
    --location="$LOCATION" \
    --keyring="$KEY_RING" \
    --key="fased-lifecycle-$role" \
    --public-key-format=pem \
    --output-file="$HOME/fased-delegated-public/$role.public.pem"
done
```

Do not grant release automation KMS administration. Grant only the exact
role-specific signing and public-key permissions after GitHub Workload Identity
Federation is configured and restricted to the official repository, workflow,
ref, and protected environment.

## Root signing ceremony

The repository tools accept public keys and detached signatures; they never
need root private keys.

Build the initial unsigned request and exact canonical payload:

```bash
delegated=()
for role in \
  application beta controller dependencies platform signer snapshot stable timestamp; do
  delegated+=(--delegated "$role=$HOME/fased-delegated-public/$role.public.pem")
done

node scripts/build-lifecycle-root-request.mjs \
  --version 1 \
  --issued-at "YYYY-MM-DDTHH:MM:SS.000Z" \
  --expires-at "YYYY-MM-DDTHH:MM:SS.000Z" \
  --request "$HOME/fased-root-v1.request.json" \
  --payload "$HOME/fased-root-v1.payload" \
  "${delegated[@]}"
```

Move the payload to two independently held root-key devices. On each selected
device, inspect the displayed payload digest and sign the exact payload:

```bash
openssl pkeyutl \
  -sign \
  -rawin \
  -inkey "/offline/path/to/root.private.pem" \
  -in "fased-root-v1.payload" \
  -out "fased-root-N.signature"
```

Return only the two 64-byte detached signature files. Finalize and verify:

```bash
node scripts/finalize-lifecycle-root-metadata.mjs \
  --request "$HOME/fased-root-v1.request.json" \
  --signature "ROOT_KEY_ID_1=$HOME/fased-root-1.signature" \
  --signature "ROOT_KEY_ID_2=$HOME/fased-root-2.signature" \
  --output "$HOME/fased-lifecycle-root-v1.json" \
  --pin-output "$HOME/fased-lifecycle-root-v1.sha256"
```

The signed root envelope and its immutable digest may be published. The
request, public keys, signatures, and signed envelope contain no private key
material.
