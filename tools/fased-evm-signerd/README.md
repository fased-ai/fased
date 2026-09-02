# Fased EVM Signer Foundation

`fased-evm-signerd` is an isolated secp256k1 key process for two EVM roles:

- `agent-service`: future capped service and payment activity;
- `strategy`: future owner-funded strategy activity.

This P1 foundation is deliberately `deny-all`. Its application socket exposes
only health, capabilities, public wallet listing, and public-address readback.
It has no transaction-signing, typed-data, transfer, token-approval, swap,
venue, bridge, withdrawal, or trading operation.

The signer has its own master key, Bolt state database, Unix socket, recovery
package kind, and role generations. It never imports or derives a Solana Agent
or Mining key. All state, key, input, recovery, and raw-export files must be
owner-only, regular, non-symlink files.

## Owner lifecycle

Initialize a new isolated state root:

```sh
fased-evm-signerd init --state /absolute/evm.db --master-key /absolute/evm.master
```

Create a key or import an exact `0x`-prefixed 32-byte key from an owner-only
file:

```sh
fased-evm-signerd create --state /absolute/evm.db --master-key /absolute/evm.master --role strategy
fased-evm-signerd import --state /absolute/evm.db --master-key /absolute/evm.master --role agent-service --private-key-file /absolute/import.key
```

`recovery-export` and `recovery-import` use an Argon2id plus AES-256-GCM
recovery package and an owner-only password file. Normal backup uses that
package. Portable raw export is exceptional, writes only to a new owner-only
file, and requires both the exact current generation and
`--acknowledge-custody-reduction`.

Revocation is generation checked. Creating a successor after revocation
increments the role generation; a stale caller cannot revoke the successor.
