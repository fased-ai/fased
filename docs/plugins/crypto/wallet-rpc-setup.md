---
summary: "Configure Solana RPC for self-hosted wallets, Satcoin mining, advanced wallet actions, and wallet readiness."
read_when:
  - You are creating or operating a Solana wallet in Fased
  - You are preparing a Mining wallet for Satcoin
  - You need reliable RPC for long-running wallet automation
title: "Solana RPC Setup"
sidebarTitle: "RPC setup"
---

# Solana RPC setup

Solana RPC is the network path your self-hosted Fased wallet uses to read chain
state and submit transactions.

Wallets, advanced wallet actions, Satcoin mining, token metadata, balances,
simulation, submit, confirmation, and claim all depend on RPC.

## Recommended provider posture

Use a reliable private or commercial Solana RPC provider for mainnet wallet
automation and Satcoin mining.

Many serious providers can work. Choose one that gives you stable HTTP access,
WebSocket support, usage visibility, and enough request capacity for long-running
wallet and mining work.

The important rule is:

```text
long-running wallet automation needs reliable RPC.
```

Public free RPC can be useful for local testing or first setup. If no custom
provider is configured, Fased can fall back to a default Solana RPC, but that
fallback should not be treated as the operating posture for unattended mining.

## Get an RPC endpoint

1. Create or open an account with a Solana RPC provider.
2. Open the provider's API key or endpoint page.
3. Create or copy an API key if the provider requires one.
4. Copy the endpoint for the target network.

Endpoint shapes:

```text
mainnet: https://YOUR_PROVIDER_MAINNET_RPC/?api-key=YOUR_API_KEY
testnet: https://YOUR_PROVIDER_TESTNET_RPC/?api-key=YOUR_API_KEY
```

Keep the key private. Do not paste it into prompts, public logs, screenshots,
issues, Discord, Telegram, or channel messages.

## Configure during wallet setup

For a new local signer Mining wallet:

```bash
fased wallet setup \
  --mode local-signer-create \
  --role mining \
  --wallet-id mining \
  --wallet-name Mining \
  --rpc-url "https://YOUR_PROVIDER_MAINNET_RPC/?api-key=YOUR_API_KEY"
```

For a new Agent wallet:

```bash
fased wallet setup \
  --mode local-signer-create \
  --role agent \
  --wallet-id agent \
  --wallet-name Agent \
  --rpc-url "https://YOUR_PROVIDER_MAINNET_RPC/?api-key=YOUR_API_KEY"
```

You can also use onboarding:

```bash
fased onboard
```

Choose the wallet setup action to configure Solana RPC for the selected wallet.

## Per-wallet RPC keys

Fased supports per-wallet RPC mappings so Agent, Mining, and Vault wallets can
use separate endpoints.

For wallet id `mining`:

```text
FASED_WALLET_SOLANA_RPC_URL__MINING=https://YOUR_PROVIDER_MAINNET_RPC/?api-key=YOUR_API_KEY
```

For wallet id `agent`:

```text
FASED_WALLET_SOLANA_RPC_URL__AGENT=https://YOUR_PROVIDER_MAINNET_RPC/?api-key=YOUR_API_KEY
```

For wallet id `solana-1`:

```text
FASED_WALLET_SOLANA_RPC_URL__SOLANA_1=https://YOUR_PROVIDER_MAINNET_RPC/?api-key=YOUR_API_KEY
```

The suffix is the wallet id uppercased with non-alphanumeric characters mapped
to underscores.

## Mining readiness

For Satcoin mining, verify RPC before capital deposit or start:

```bash
fased wallet signer doctor --json
fased mining readiness --wallet mining
fased mining status
```

Mining readiness should show:

- wallet selected
- signer ready
- RPC ready
- funding ready
- miner initialized
- token account ready

RPC failures can cause missed cycle reads, submit failures, stale slot data,
delayed confirmations, cycle-accounting delays, and claim delays.

## Operator rule

Treat RPC as part of the mining machine.

For serious operation:

- use a reliable primary provider
- keep a backup endpoint available when possible
- watch readiness and history after the first cycles
- investigate repeated RPC failures before increasing commit
- keep API keys out of public logs and screenshots

Satcoin mining is operator mining from your own Fased runtime.
