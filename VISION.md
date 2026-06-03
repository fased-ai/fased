## Fased Vision

Fased is a self-hosted agent runtime for operators who want real control over:

- runtime and host access
- browser control surfaces
- wallets and signer posture
- optional Fased Network and SAT modules
- plugins, channels, offers, and reviewed operator workflows

Project overview: [`README.md`](README.md)  
Contribution policy: [`CONTRIBUTING.md`](CONTRIBUTING.md)  
Security policy: [`SECURITY.md`](SECURITY.md)

## Product direction

Fased is no longer aimed at being only a generic chat agent.

The current shape is:

- browser-first control UI
- local or hosted onboarding flows
- token-protected and device-auth protected control pages
- wallet-aware runtime policy
- SAT mining
- bonded Fased Network operator surfaces
- operator network views and accounting records
- local offer records and marketplace discovery

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

Fased should make the safe path the default without pretending the runtime is low-power.

Current principles:

- closed ports beat casual public exposure
- Tailscale or equivalent private networking is the preferred remote posture
- gateway token and device auth protect sensitive web surfaces
- high-risk capabilities stay explicit and operator-controlled
- onboarding should expose the security posture, not hide it

## Wallets, mining, bond, and federation

Wallet and network features belong in the same sovereign runtime, but they should
not all be turned on at once.

Healthy operator sequence:

1. bring up the runtime
2. confirm private access and restart health
3. choose wallet posture
4. attach signer or passkey-backed wallet flows where needed
5. define sweep and funding policy before funds
6. add mining, federation, and bond only after the base runtime is stable

Current module split:

- `Mining` handles SAT mining participation
- `Bond` uses SAT bond positions as an operator trust signal where enabled
- `Payments` stay in explicitly configured rails
- `Operator records` track fees, reserves, reconciliation, and claimable records where enabled

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

- a self-hosted agent for one operator or one trust boundary
- a sovereign wallet-aware runtime
- a bonded network participant when the operator chooses that path
- a place where chat, marketplace, network, and market/news review workflows can live under one policy surface

## Guardrails

Things we should keep resisting:

- pretending one shared gateway is a hardened multi-tenant system
- turning every workflow into a public-internet default
- mixing admin/control access with public federation routing
- turning SAT into generic message gas
- hiding risk boundaries behind “easy mode” marketing

Strong defaults matter more here than in a normal chatbot project because the repo
already includes wallet, network, mining, and market review surfaces.
