---
summary: "Fased capabilities across the Gateway, chat apps, Agents, wallets, Fased Network, SAT, offers, and marketplace workflows."
read_when:
  - You want the clean product-level feature list
  - You want to see what is live now versus what is still roadmap
title: "Features"
---

# Features

This page is the product view of what Fased supports today.

Use it when you want the major capabilities without digging through lower-level implementation details.

## At a glance

<Columns>
  <Card title="Gateway and control" icon="monitor">
    Browser-first Control UI, CLI, sessions, logs, and safety controls in one setup.
  </Card>
  <Card title="Chat apps" icon="message-square">
    One Gateway can serve many messaging apps at once instead of splitting setup across isolated bots.
  </Card>
  <Card title="Wallet, Fased Network, and SAT" icon="coins">
    Wallet controls, SAT mining, Fased Network profile, and bond controls are optional modules in the same setup.
  </Card>
  <Card title="Marketplace workflows" icon="store">
    Local offers, public discovery, and reviewed service readiness live in the Control UI.
  </Card>
  <Card title="Nodes and devices" icon="smartphone">
    Mobile and local-device nodes extend Fased to cameras, audio, screens, and Canvas-style surfaces.
  </Card>
  <Card title="Automation and plugins" icon="plug">
    Skills, plugins, hooks, scheduled tasks, and sandboxed tools let the agent grow into your workflows.
  </Card>
</Columns>

## Major features available now

### 1. Gateway you control

Fased gives you one Gateway that you control on your own machine or server.

Current core surfaces:

- Dashboard, Chat, Agents, Logs, Usage, and Advanced admin surfaces
- CLI for onboarding, status, chat apps, wallets, Fased Network, and ops work
- session management and chat history
- routing, logs, health checks, and restart-safe service operation
- Local versus Hosting profiles for different setup needs

### 2. Chat apps and remote access

Fased can connect one Agent to many communication surfaces.

Current channel and messaging capabilities include:

- WhatsApp
- Telegram
- Discord
- IRC
- Mattermost
- iMessage / BlueBubbles
- Slack
- Signal
- Matrix
- Nextcloud Talk
- Microsoft Teams
- Feishu
- Google Chat
- Synology Chat
- Line
- Nostr
- Tlon
- Twitch
- Zalo
- Zalo Personal
- group chat and mention-based activation
- images, audio, and document handling
- long-response streaming and chunking

The product point is that the same Gateway can serve many chat apps at once.

### 3. Agent work and routing

Fased is not just a message relay.
It is an agent setup with safety controls.

Current agent capabilities include:

- multi-agent routing
- isolated sessions by workspace, sender, or agent role
- memory and session compaction
- tool use and plugin tool registration
- embedded Fased agent over the Gateway RPC path
- provider auth and subscription/OAuth paths where supported
- sandbox and tool-policy controls

### 4. Wallet controls

The wallet layer is a real product surface with inventory, controls, and signer
health.

Current wallet features include:

- wallet inventory and role visibility
- send flows and recent wallet activity
- signer health checks
- shared wallet controls and spend limits
- Agent wallet visibility
- mining wallet visibility
- bond Vault visibility

The wallet page is the inventory and controls surface. Mining control and bond
lifecycle actions live on their own pages.

### 5. SAT mining

SAT mining is a first-class capability in Fased.

Current mining features include:

- SAT mining page and controls
- capital, commit, and cycle visibility
- singleton Mining wallet assignment
- cycle history and activity
- restart-aware support for continued use

Mining is the SAT issuance and participation layer. Payments and bond lifecycle
controls remain separate.

### 6. Fased Network profile and public participation

Fased Network is the network participation layer on top of a healthy Fased
setup.

Current Fased Network features include:

- handle and token state
- trust and hosted status visibility
- hosted-route health awareness
- public participation readiness checks
- profile tied to the same Fased setup

Fased Network is how the agent becomes a public network participant.
Local control stays on the local setup surfaces.

### 7. Bonded operator path

Bond is the SAT-backed trust and eligibility layer for operators.

Current bonded operator features include:

- bond Vault selection
- bond open / top-up / unlock / withdraw lifecycle
- proof of bond Vault control
- derived operator scopes
- bonded lane readiness in Fased Network UI

Current first-layer bonded capabilities include:

- publishing public offers
- clearer payment setup visibility
- basic directory priority
- basic routing priority

### 8. Offers and marketplace

Fased now includes the operator surfaces for local offers and public discovery.

Current marketplace surfaces include:

- local offer publishing and management
- public marketplace discovery
- selected-offer execution surface
- payment setup and review flow separation
- bonded public visibility model

Important boundary:

- local offers can exist without public bonded visibility
- marketplace discovery is separate from any payment provider
- payment setup remains separate from bond

### 9. Operator status and evidence

Operator accounting and evidence surfaces exist today, but later fee-related
surfaces remain controlled rollout items.

Current operator status features include:

- operator status surface
- read-only and gated readiness states
- accounting / reserve / reconciliation evidence surfaces
- read-only operator reporting
- fee-related reporting groundwork

What is true right now:

- bond is live
- bonded operator lanes are live
- operator status and evidence surfaces exist
- full live collection and service-fee paths remain controlled rollout items

### 10. Plugins, skills, and automation

Fased supports setup-specific extension and automation paths.

Current extension features include:

- plugin manifests and plugin agent tools
- community and extension package support
- crypto plugin surfaces
- hooks
- scheduled tasks
- webhook and polling flows
- Gmail Pub/Sub automation path
- browser automation and tool workflows

### 11. Nodes and device surfaces

Fased can extend into paired device and node surfaces.

Current node features include:

- iOS node
- Android node
- Canvas-style mobile surfaces
- camera, audio, and media understanding paths
- local device pairing and remote-node workflows

## Current feature map by product area

If you want the shortest product summary, read it like this:

- `Gateway`: the service you run, CLI, browser UI, health, sessions, logs
- `Channels`: chat apps across many messaging platforms
- `Agent runtime`: routing, tools, memory, sessions, policy
- `Wallet`: inventory, signer health, send flows, wallet-role visibility
- `Mining`: SAT issuance and mining operations
- `Fased Network`: public profile, trust, hosted route, network participation
- `Bond`: SAT-backed operator eligibility and proof
- `Offers`: local publishing and remote discovery
- `Operator status`: evidence and controlled maturity path
- `Nodes`: mobile and device-linked surfaces
- `Plugins and automation`: extension and workflow system

## Roadmap, not current features

Keep roadmap items labeled separately from current features.

The next public roadmap lanes are:

- bonded verified chat
- stronger operator evidence and operator controls
- reviewed market automation lanes
- news and market-intelligence tools

See [Roadmap](/reference/roadmap) for the next group of work.

## Related docs

- [Fased](/index)
- [Fased Network Guide](/start/federation)
- [SAT bond operator overview](/start/bond-operator-economy)
- [Offers and Marketplace](/start/offers-marketplace)
- [Wallet](/plugins/crypto/wallet-page)
- [Mining](/plugins/crypto/mining-page)
