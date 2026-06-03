---
summary: "Control UI design system for navigation, cards, tabs, modals, widgets, forms, and operator surfaces."
read_when:
  - Changing the Control UI layout, theme, dashboard, cards, modals, or navigation
  - Reviewing whether a new page belongs under Agent setup, Dashboard, or Advanced
title: "Control UI Design"
---

# Control UI Design

This is the source of truth for the Fased browser Control UI. Keep new work
aligned with this page before adding page-specific styling or one-off layouts.

## Product model

The Control UI is a workbench for one selected Agent, plus a small set of global
operator pages.

- **Dashboard** is the compact overview board.
- **Chat** is the browser conversation surface for the selected Agent/session.
- **Agents** owns normal setup: the Providers tab for Agent model/provider
  selection, Channels, Skills, Tools, Memory, Services, Tasks, Sessions, Files,
  and Coordination.
- **Wallets**, **Mining**, **Fased Network**, **Marketplace**, **Extensions**,
  **Notifications**, and **Usage** are first-class global operation pages.
- **Advanced** owns raw Config, Debug, and Nodes. Do not put Debug or Nodes back
  into primary navigation.

Global pages such as Providers, Channels, Services, Tasks, Skills, Memory,
Debug, and Nodes may still exist for deep links or admin workflows. Hide them
from primary navigation when their normal workflow now lives under a selected
Agent or Advanced.

## Theme

Use one background color per theme and let borders, spacing, and typography do
the separation.

- Dark theme is graphite/black with restrained white foreground actions.
- Light theme is white/neutral with black foreground actions.
- Do not use decorative gradients, floating blobs, or color-heavy backgrounds.
- Use semantic color only for state: green ready, amber warning, red error,
  blue/info only when it carries meaning.
- Avoid green buttons as the default action style. Primary actions are white on
  dark theme and black on light theme.

Use the shared CSS tokens from `ui/src/styles/base.css`:

- Surfaces: `--bg`, `--card`, `--panel`, `--bg-hover`.
- Text: `--text`, `--text-strong`, `--muted`.
- Lines: `--border`, `--border-strong`.
- State: `--ok`, `--warn`, `--danger`, `--info`.
- Radii: prefer `--radius-sm` or `--radius-md`; use `--radius-lg` only for
  larger modal/card containers.

## Typography

- Use the shared body font for app UI and the mono font for counters, IDs,
  tokens, addresses, and code-like data.
- Keep card headings compact. Do not use hero-sized type inside tools, cards,
  sidebars, or dashboards.
- Use tabular numbers for counters, balances, tokens, and usage.
- Text must fit its container on desktop and mobile. Prefer truncation with a
  tooltip for IDs and paths.

## Shell

The shell has three persistent pieces:

- Collapsible left navigation.
- Top bar.
- Scrollable content area.

Navigation rules:

- Sidebar is icon-only when collapsed and icon plus text when expanded.
- Use the order in `ui/src/ui/navigation.ts`: Dashboard, Chat, Agents, Wallets,
  Mining, Fased Network, Marketplace, Extensions, Notifications, Usage,
  Advanced, Logs.
- No section group cards in the sidebar.
- Selected nav state should be simple: background or text contrast only. Do not
  add extra white border outlines around the selected item.
- Hover state is a subtle grey/neutral surface with a tooltip when collapsed.
- Use lucide icons, not custom inline icons, when a matching icon exists.

Top bar rules:

- The top bar owns the current page title, global health dot, docs icon, and the
  account/theme/sign-out menu.
- Page-specific compact actions can appear in the top bar. Dashboard uses this
  for `+ Widget` and refresh. Chat uses this for chat controls.
- Do not repeat the same page title in the page body.
- Health is a dot with hover detail, not a large card or text block.
- Docs, theme, and sign-out live in compact icon/menu affordances.

## Cards

Cards are flat control surfaces:

- One card layer only. Do not place page sections inside a giant parent card.
- Use a border, neutral background, compact padding, and small radius.
- Avoid nested cards. Use dividers, rows, or compact metric blocks inside a
  card when content needs grouping.
- Repeated items can be cards. Whole pages should not be a card inside a card.
- Keep rows clickable when they reveal details; keep controls visible but
  compact.

Summary cards use this pattern:

- Big number, icon, avatar, or state in the center/top.
- Short label below.
- One or two compact actions.
- Optional status dot or helper icon, not paragraphs of explanation.

Examples:

- Agent setup cards: Agent, Skills, Models, Channels, Tools, Tasks, Sessions,
  Services, Usage, Extensions.
- Dashboard widgets: Agents, Usage, Wallets, Mining, Fased Network.

## Dashboard Widgets

Dashboard is a compact widget board, not a launch-link directory.

Default widgets:

- Agents: total Agents, tasks, sessions.
- Usage: token usage history over the selected window.
- Wallets: wallet role counts and SOL balances.
- Mining: status, SAT wallet balance, capital, recent mining history.
- Fased Network: hosted status and address/handle summary.

Rules:

- Widget controls live in the dashboard top bar.
- Widgets are draggable by their header.
- Widget content must not create horizontal scroll. Wrap or truncate content.
- If a widget has too much feed/chart content, scroll vertically inside the
  widget body.
- Widgets should size to useful content by default, with a sensible max height.
- Widgets pack in the CSS-column masonry board from `ui/src/styles/dashboard.css`.
  The saved layout stores one ordered widget list; old multi-column saved layouts
  are normalized into that order.
- Desktop should fill available width with additional visual columns on wider
  screens. Mobile can collapse to one column and scroll normally.
- Cards may support height resize. Resizing should change the vertical body
  space, not introduce horizontal content scroll.
- Do not add Gateway Access or Runtime Clients widgets for normal users; those
  are Advanced/Debug diagnostics.

## Tabs

Tabs are compact segmented controls:

- Use icon plus label when space allows.
- Selected tab must have readable text in both dark and light themes.
- Keep tabs close together and low height.
- Do not use large rounded marketing pills for dense setup panels.

Agent tabs must stay Agent-scoped. Do not move global extension lifecycle,
raw debug, or raw config into Agent tabs.

## Modals

Use real modal dialogs for create, edit, review, install, grant, and destructive
confirm flows.

Modal rules:

- Center the modal and cap it to viewport width/height.
- Header stays visible; body scrolls vertically when needed.
- Backdrop click closes normal modals.
- Do not close silently when an action fails. Show success/error state in the
  modal.
- Do not place create/edit forms at the bottom of a page as a replacement for a
  modal.
- Destructive actions require explicit confirmation and visible consequence
  text.

Examples:

- Create Agent.
- Create/Edit Skill.
- Review plugin-catalog skill install.
- Skill dependency install plan.
- Wallet send approval.
- Offer/request creation.

## Helper Icons

Explanatory copy belongs behind a small helper icon, not inline paragraphs.

- Use a lucide help/question icon.
- Do not wrap helper icons in decorative bubbles.
- Hover or click opens the shared popover/modal style.
- Helper text uses normal sentence case, not uppercase labels.
- Helper popovers must fit within the viewport.

Use helper icons for concepts like caps, per-transaction limits, mining cycle
states, dashboard metrics, service setup, and Advanced diagnostics.

## Status

Status is visual and terse.

- Use a small dot or short colored text.
- Do not use bubble badges for every state.
- Green means ready/healthy/loaded.
- Amber means setup needed, stale, restart required, or partial.
- Red means blocked/error.
- Neutral means disabled, unavailable, or not configured.

Every status should have a specific data source. Avoid wording such as
"active" unless it comes from live runtime/session data.

## Forms

Forms should be direct and typed.

- Prefer plain fields mapped to real config paths over raw JSON.
- Use select controls for finite choices.
- Use toggles for binary settings.
- Auto-save small isolated toggles when safe.
- Use an explicit Save button for grouped forms where partial writes are risky.
- Hide raw config behind Advanced unless the page is specifically Advanced.

For skills and services, show what the user can fix:

- Missing credential: typed field.
- Missing dependency: install plan with package manager, command, PATH target,
  pin/integrity state, and verification result.
- Wrong OS/toolchain: clear manual setup note.

## Ownership Rules

Keep setup in the place users expect:

- Models/provider accounts: Agent > Providers.
- Channel accounts and routing: Agent > Channels.
- Service credentials: Agent > Services or the relevant service page.
- Tool access policy: Agent > Tools.
- Skills: Agent > Skills, with plugin-catalog/library/create/edit/install flows scoped
  to the selected Agent.
- Wallet grants for skills: Wallets > Access / Skill Grants.
- Plugin runtime lifecycle: Extensions.
- Hooks lifecycle packs: Extensions > Hooks.
- External webhook routing: Agent > Tasks > Webhook Triggers.
- Raw config, Debug, Nodes: Advanced.

Do not duplicate the same setup flow in multiple top-level pages. Deep links are
fine; primary navigation should stay simple.

## Security UI

Security-sensitive surfaces must separate install, allow, and grant:

- Installing a skill writes files or dependencies only.
- Allowing a skill attaches it to an Agent.
- Granting tools/wallets gives runtime authority.
- Mining and vault wallet roles are not available to arbitrary skills.
- External packages require visible trust and integrity warnings.

Wallet, mining, exec, plugin-catalog, and dependency installer flows must show
what is being changed before the action runs.

## Testing Expectations

Any UI change touching shared layout or workflows should include at least one
focused browser test for the real click path.

Required checks by change type:

- Navigation/sidebar/topbar: routing and responsive browser test.
- Modal changes: button opens modal, backdrop closes, success/error remains
  visible.
- Dashboard widgets: widget add/remove/move and no horizontal content overflow.
- Agent setup tabs: selected Agent scope is preserved.
- Skills: create/edit, review install, dependency install, Agent allow toggle.
- Wallet/mining: review gates and no policy broadening.

Run targeted tests first, then the broader UI suite when the touched surface is
shared.
