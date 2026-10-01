---
title: "Fased Vision"
summary: "Current product direction, safety posture, and module boundaries."
read_when:
  - You need the product direction
  - You are planning roadmap or positioning changes
---

## Fased Vision

Fased is an agent setup you can run on your own computer or server when you
want real control over:

- host access and remote access
- the browser Control UI
- wallets and signer posture
- optional Fased Network and SAT modules
- plugins, chat apps, offers, and reviewed marketplace workflows

Project overview: [`README.md`](https://github.com/fased-ai/fased/blob/main/README.md)
Contribution policy: [`CONTRIBUTING.md`](https://github.com/fased-ai/fased/blob/main/CONTRIBUTING.md)
Security policy: [`SECURITY.md`](https://github.com/fased-ai/fased/blob/main/SECURITY.md)

## Product direction

Fased is no longer aimed at being only a generic chat agent.

The current shape is:

Near-term roadmap:

- bonded verified chat and public inbox
- room-host and mirrored bonded communication
- market review workflows
- news and market-data review workflows

## Local and hosting profiles

Fased should be easy to run in two honest modes:

### Local

Use this when the machine is mainly your own workstation or private box.

Preferred posture:

- gateway on loopback
- closed ports by default
- remote access through Tailscale, SSH tunnel, or another private layer
- dashboard and control pages accessed as a private admin surface

### Hosting

Use this when the machine is a VPS or long-lived node.

Preferred posture:

- managed runtime install
- explicit gateway token and device-auth protections
- private access first, public routing only where intentionally enabled
- public federation route treated as a network surface, not the admin surface

## Access and safety posture

Fased should make the safe path the default without pretending the agent is
low-power.

Current principles:

- closed ports beat casual public exposure
- Tailscale or equivalent private networking is the preferred remote posture
- gateway token and device auth protect sensitive web surfaces
- high-risk capabilities stay explicit and operator-controlled
- onboarding should expose the security posture, not hide it

Wallet and network features belong near the agent, but they should not all be
turned on at once.

Safe setup sequence:

Current module split:

## Plugins, skills, and extensions

Core should stay lean.

The default expansion path is:

- plugin SDK
- extensions
- skills
- marketplace-distributed capability bundles

Bundled skills should stay narrow.
Optional capability should usually ship outside core unless there is a strong
product or security reason.

## What Fased should become

The target product is:

- an agent you can run for one person, team, or trust boundary
- wallet-aware automation with clear controls
- a bonded network participant when the operator chooses that path
- a place where chat, marketplace, network, and market/news review workflows can
  live under one control surface

## Guardrails

Things we should keep resisting:

- pretending one shared gateway is a hardened multi-tenant system
- turning every workflow into a public-internet default
- mixing admin/control access with public federation routing
- turning SAT into generic message gas
- hiding risk boundaries behind “easy mode” marketing
