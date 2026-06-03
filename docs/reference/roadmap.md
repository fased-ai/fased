---
summary: "Current Fased roadmap after the wallet, Fased Network, SAT, and operator trust tranche."
read_when:
  - You want the next product direction
  - You need a public-facing roadmap summary
title: "Roadmap"
---

# Roadmap

This roadmap reflects the current Fased direction, not the earlier upstream project
shape.

## Current completed tranche

The current tranche is centered on:

- wallet selection and signer posture
- SAT mining
- Fased Network bond and bonded operator flows
- operator trust read-only status UI
- local offers and marketplace offer discovery

## Next implementation lanes

### 1. Bonded verified chat

Build self-hosted communication around:

- verified DM
- public inbox
- bonded room host
- append-only signed room logs
- optional bonded room mirrors

Direction:

- off-chain messaging
- local storage per node
- signed message envelopes
- HTTP / WebSocket sync
- end-to-end encryption

### 2. Marketplace and operator maturity

- strengthen public offer execution flows
- mature operator evidence into reviewed collection and payment records only when approved
- keep bond as trust and anti-spam policy, not message gas

### 3. Advanced wallet-action engine

Planned as a separate reviewed surface on top of wallet policy, not as an
implicit default behavior of the runtime.

### 4. Data and market-intelligence engine

Planned as a distinct operator or plugin lane for:

- news ingestion
- market summaries
- signal review
- research workflows

This should remain clearly separated from any claim of financial advice.

### 5. Public release packaging

- clean public docs and legal surface
- public repo release flow
- npm package publication for `fased` only after the release/update path is stable

## Design principle

Fased should keep using SAT and bond for:

- trust
- operator eligibility
- spam resistance
- directory identity

and avoid turning every higher-level product action into on-chain message gas.
