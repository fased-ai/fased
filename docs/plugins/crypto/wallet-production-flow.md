---
summary: "Production wallet setup, custody choices, roles, policy, reviewed execution, mining, sweeps, and recovery."
read_when:
  - Preparing Agent, Mining, or Vault wallets for real value
  - Choosing native, Turnkey, or hardware-backed custody
title: "Wallet operations and security"
sidebarTitle: "Wallet security"
---

# Wallet operations and security

Use this guide after installing Fased and before funding a runtime wallet.

## Recommended layout

- one or more limited **Agent** working wallets;
- exactly one active **Mining** wallet;
- one or more manual **Vault** wallets;
- an optional hardware-backed Vault for reserve and high-value manual sends;
- long-term reserve outside unattended Agent and Mining wallets.

Do not reuse one account for every role. Role is a permanent signer-policy
input, not a cosmetic label.

## 1. Choose custody before funding

### Native `fased-signerd`

Use the native signer for self-hosted Agent and Mining operation and for
reviewed hot/warm Vault work. Go creates/imports and uses the key; Node does not
receive plaintext key material in the supported path.

- Local Linux/macOS/WSL2 is a same-user boundary. Use limited balances.
- VPS Hosting separates signer and Gateway OS accounts and removes Gateway
  signer sudo/control access.
- Local Docker separates containers and volumes but is not VPS Hosting or a
  boundary against the host/Docker administrator.

### Wallet Standard hardware Vault

In **Wallets**, choose **Attach Wallet Standard Vault** from a browser with a Solana
Wallet Standard wallet. Fased stores the public address only. It prepares and
simulates one short-lived immutable review; the browser wallet signs it; Fased
verifies that the signed message is byte-for-byte unchanged; then broadcast is
attempted once.

Wallet Standard cannot prove an account is hardware-backed. Confirm the
account, destination, mint, and amount on the hardware device itself.

### Turnkey

Turnkey is the implemented provider-managed lane. Use a dedicated API user and
an independently reviewed Turnkey organization policy with a non-empty
condition. The readiness probe confirms only that the policy reference exists;
Turnkey read queries are not policy-enforced. For every reviewed signature,
Fased requires the exact completed signing activity's policy evaluations to
contain `OUTCOME_ALLOW` for the configured policy ID and rejects an activity if
another policy also returns `OUTCOME_ALLOW` before broadcast. Turnkey's policy
engine remains the custody authority.

The Turnkey API credential is available to the Gateway process. Therefore the
post-signing evaluation check protects normal Fased execution, but it is not by
itself a boundary against a fully compromised Gateway that calls Turnkey
directly. Use a dedicated Turnkey API user/sub-organization and make the
provider policy independently restrict that user, exact wallet/account,
allowed activity type, destinations, assets, and limits. No other permissive
policy should authorize the same signing activity.

Turnkey supports manual reviewed typed SOL/SPL transfers. Fased stores the
immutable review, verifies returned signed bytes, broadcasts once, and treats
an ambiguous result as terminal until exact reconciliation.

Privy is unavailable. Do not treat its placeholder configuration as wallet
creation, balance, or signing support.

## 2. Create or import

New native wallets are created inside Go and return only a public address. The
first wallet wizard installs/starts the version-matched signer automatically;
normal users do not install Go.

Import is not a dashboard or chat field. Use `fased wallet import` from the
native Local or Hosting operator terminal. It accepts one owner-only Solana CLI
64-byte JSON keypair file by descriptor. It does not accept seed phrases,
base58, hex, base64, command arguments, environment secrets, or browser input.

See [Self-hosted wallet signer](/plugins/crypto/wallet-self-hosted) for Local
and Hosting commands.

After creation/import, verify:

```bash
fased wallet signer doctor --json
fased wallet status --json
```

Do not fund the address until the id, role, address, policy hash, and RPC
readiness match what you intended.

## 3. Review the signer-owned role baseline

A new native wallet starts with signer-owned role baseline v1. The baseline is
useful but bounded: Agent/Vault owner transfers require exact review,
destination, and positive caps; Mining accepts only release-bound typed SAT
actions plus reviewed owner movement.

Every executable policy must explicitly name:

- typed operations;
- exact programs;
- assets/mints;
- destinations;
- positive per-transaction and daily caps.

Checked SPL transfers also explicitly require the System, Associated Token
Account, and selected Token/Token-2022 programs. Go always derives and includes
the canonical idempotent destination-account creation instruction, validates
the source and any existing destination account, and charges possible rent to
the signer-owned SOL reservation. This lets the first SAT transfer to a new
recipient work without accepting caller-selected account creation.

Empty or missing lists mean no signing. The signer returns policy version/hash
in health. A UI change stays pending until the signer acknowledges that exact
hash. The Gateway can request a tighter policy; initial authority and later
loosening use the native owner/admin workflow.

Registered legacy wallets are migrated automatically by `fased update`. The
transaction preserves the wallet ID, public address, role, and RPC; imports the
key into the current signer; activates the matching built-in role baseline;
and verifies the candidate before commit. Failure restores the prior runtime
and wallet state. A successful commit removes its temporary rollback snapshot.

For authority beyond the built-in role baseline, copy the role template to a
private absolute path, replace its wallet ID with the canonical signer ID,
review every permission, and apply it through the advanced native owner path:

```bash
# Local Linux, macOS, or WSL2
cp "$HOME/.fased/share/signer-policies/<role>.json.template" \
  /secure/absolute/policy.json
chmod 0600 /secure/absolute/policy.json
"$HOME/.fased/bin/fased-signer-policy" \
  --initial-install \
  --policy-file /secure/absolute/policy.json
```

```bash
# VPS Hosting
sudo cp /usr/local/share/fased/signer-policies/<role>.json.template \
  /root/fased-<role>-policy.json
sudo chmod 0600 /root/fased-<role>-policy.json
sudoedit /root/fased-<role>-policy.json
sudo /usr/local/sbin/fased-signer-policy \
  --initial-install \
  --policy-file /root/fased-<role>-policy.json
```

Registry handles and signer ids can differ: `@wallet:agent-2` maps to canonical
signer id `agent_2`. Use the canonical signer id in native policy/network input.

## 4. Enter one RPC; keep execution and read responsibilities separate

Fased deliberately has two RPC planes:

- **Signer execution RPC:** encrypted, versioned, and scoped per native wallet.
  The signer uses it for native balance reads, construction, simulation,
  broadcast, and reconciliation. Configure it through
  `fased-signerd admin network put`.
- **Gateway read/preparation RPC:** used for dashboard token inventory, SAT
  inspection/watchers/readiness, federation and bond reads, Jupiter/Trigger
  preparation, and provider/hardware lanes.

The simple wizard stores the selected endpoint in both planes, so that URL or
token is visible to Gateway code. For stronger separation, give the Gateway a
different read-only endpoint/credential and keep execution credentials only in
signer state. The Gateway has no arbitrary RPC proxy through the signer.

Protocol-v2 native execution does not trust the Gateway value. Signer health
returns only readiness plus version/hash metadata, not its encrypted URL/token.

Use dedicated/private RPC for production mining and wallet actions. Public RPC
is suitable only for limited testing.

See [Solana RPC setup](/plugins/crypto/wallet-rpc-setup).

## 5. Role contract

### Agent

Agent is the only general automation role. Permit only the exact SOL/SPL mints,
programs, destinations, per-transaction caps, and daily caps the work needs.
Wallet-capable skills also require their own explicit Agent-wallet grant.

Jupiter swap and Trigger mutation are preview capabilities in this release and
are absent from starter policies. The signer rejects their execution by default;
normal Local and Hosting installers do not enable the qualification-only live
switch. Do not enable them for production funds until the exact generated
RouteV2/Trigger codec and a live Jupiter qualification are published for the
same release. Prepared, signed, broadcast, and unknown states are durable, but
storage/idempotency does not replace exact protocol decoding. Never retry an
ambiguous result with changed parameters.

### Mining

Mining is reserved for generated SAT protocol operations, mining capital,
fees, claims, cleanup, and reviewed SAT sweeps. It needs SOL for fees/capital
and may receive SAT rewards, but it is not a generic token wallet or arbitrary
swap source.

### Vault

Vault is manual-only. Native Vault work uses signer-owned WebAuthn bound to the
exact transaction/policy hash. Do not enable generic direct signing to make a
Vault send work. Prefer on-device hardware review or a strong provider policy
for reserve value.

## 6. What a review binds

`review.prepare` creates an immutable review containing the wallet, role,
operation, decoded destinations/mints/amounts, transaction digest, policy
version/hash, request id, and expiry. `review.execute` accepts only the exact
prepared artifact and a valid one-time authorization.

The UI should show:

- source wallet id/role and public address;
- destination or wallet handle;
- SOL amount or SPL mint/amount;
- decoded programs and route/order type;
- per-transaction and daily cap impact;
- policy version/hash;
- request id and expiry;
- simulation and estimated fee when available.

Signed reviews can be recovered after UI expiry only by querying the exact
stored signer artifact. Unsigned expired reviews cannot be revived. Broadcast
or unknown requests are reconciled; they are not rebroadcast.

## 7. WebAuthn and hardware review

Signer-owned approval is verified in Go and binds an exact review. Vault is
manual-only. Agent and generated Mining operations inside their narrow policies
do not prompt for a passkey; work outside policy is rejected unless the owner
separately enables an exact reviewed lane.

The optional **Control UI account passkey** under **Account Security** is a
separate Gateway-owned credential. It does not affect Agent or Mining readiness
and cannot satisfy signer-owned approval. A hardware wallet with an on-device
transaction display is stronger for high-value manual approval.

Keep at least two recoverable WebAuthn credentials where supported and test the
operator recovery procedure before funding a Vault.

## 8. Skill grants

Installing a skill never creates wallet permission. A grant must explicitly
name:

- allowed actions;
- Agent role and exact wallet ids;
- Solana chain;
- trusted registry URL, or explicit `local` source;
- input/output mints used by the request;
- amount and slippage caps;
- whether autonomous or scheduled use is allowed.

Omitted dimensions deny the request. The signer policy is still the final
authority and can be narrower.

## 9. Durable caps and ambiguous broadcasts

The native signer reserves caps atomically in bbolt before signing. Concurrent
requests cannot both spend the same remaining daily allowance. Restarting does
not reset totals.

Signer states are `reserved`, `broadcast`, `confirmed`, `failed`, or `unknown`.
`broadcast` and `unknown` count against the cap. Fased preserves the exact
signature/signed bytes and reconciles them before any new attempt.

Jupiter swap and Trigger create/deposit/cancel/withdraw flows also persist
their external authorization/artifact state. An uncertain provider response
must be resolved, not repeated.

## 10. Working balances and sweeps

"Low balance" means the maximum value you intentionally accept as exposed by
that role and host—not a fixed Fased number.

- Agent: everyday working capital only.
- Mining: fee headroom, configured capital, and short-lived rewards.
- Native hot/warm Vault: only deliberate manual value.
- Hardware/provider Vault: reserve appropriate to that custody review.
- Offline reserve: outside the runtime.

Mining supports typed SAT claim/sweep behavior. Agent recurring SOL/SPL plans
start disabled and are rechecked against current signer policy/caps each run.
Vault has no autonomous recurring send.

## 11. Production checklist

Before funding or enabling automation, verify all of these:

1. the installer and signer version match;
2. signer artifact checksum and attestation verification succeeded;
3. `fased wallet signer doctor --json` is healthy;
4. wallet id, permanent role, and public address are correct;
5. signer execution RPC and Gateway read RPC are ready for that wallet;
6. policy version/hash is acknowledged and every allowlist/cap is explicit;
7. signer WebAuthn is tested for manual native reviews, or the selected
   hardware/provider policy is tested;
8. cold restart preserves wallet, policy, cap, and request state;
9. a concurrent duplicate is rejected/replayed, not signed twice;
10. an ambiguous broadcast is reconciled without replacement;
11. an offline, encrypted backup restores the same public address, policy hash,
    WebAuthn inventory, durable caps, and unresolved request state under the
    [Migration Guide](/install/migrating);
12. balances fit the role's intentional loss envelope.

## Related docs

- [Wallet](/plugins/crypto/wallet-page)
- [Wallet roles and policies](/plugins/crypto/wallet-roles-and-policies)
- [Wallet signer architecture](/plugins/crypto/wallet-signer-provider-architecture)
- [Self-hosted wallet signer](/plugins/crypto/wallet-self-hosted)
- [Wallet passkeys](/plugins/crypto/wallet-control-passkey)
- [Mining](/plugins/crypto/mining-page)
