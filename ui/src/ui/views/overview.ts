import { html, nothing } from "lit";
import {
  addDashboardWidget,
  dashboardWidgetIds,
  moveDashboardWidget,
  normalizeDashboardLayout,
  removeDashboardWidget,
  resetDashboardLayout,
  type DashboardLayout,
  type DashboardWidgetId,
} from "../dashboard-layout.ts";
import type { FederationStatus, FederationToken } from "../federation-api.ts";
import type { GatewayHelloOk } from "../gateway.ts";
import { icons, type IconName } from "../icons.ts";
import { pathForTab, type Tab } from "../navigation.ts";
import type { UiSettings } from "../storage.ts";
import type {
  DoctorMemoryInventoryPayload,
  DoctorMemoryValidationPayload,
  ModelsCatalogStatusResult,
  PluginsMarketplaceListResult,
  AgentsListResult,
  SessionsUsageResult,
} from "../types.ts";
import type { WalletNamedWallet, WalletStatus } from "../wallet-api.ts";

export type OverviewProps = {
  onboarding: boolean;
  managedMode: boolean;
  basePath?: string;
  connected: boolean;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  password: string;
  canSignOut: boolean;
  loginGrantInput: string;
  loginGrantPending: boolean;
  loginGrantError: string | null;
  lastError: string | null;
  authNotice: string | null;
  authSessionExpiresAt: string | null;
  authSessionIdleTimeoutSeconds: number | null;
  overviewAdvancedUnlocked: boolean;
  overviewSecretsRevealUntilMs: number;
  presenceCount: number;
  sessionsCount: number | null;
  cronEnabled: boolean | null;
  cronJobs: number | null;
  cronActiveTasks: number | null;
  cronNext: number | null;
  lastChannelsRefresh: number | null;
  federationToken?: FederationToken | null;
  federationStatus?: FederationStatus | null;
  walletStatus?: WalletStatus | null;
  walletNamedWallets?: WalletNamedWallet[];
  defaultWalletId?: string | null;
  modelCatalogStatus?: ModelsCatalogStatusResult | null;
  pluginsMarketplace?: PluginsMarketplaceListResult | null;
  memoryInventory?: DoctorMemoryInventoryPayload | null;
  memoryValidation?: DoctorMemoryValidationPayload | null;
  agentsList?: AgentsListResult | null;
  usageResult?: SessionsUsageResult | null;
  usageLoading?: boolean;
  dashboardLayout: DashboardLayout;
  dashboardWidgetDrawerOpen: boolean;
  onSettingsChange: (next: UiSettings) => void;
  onPasswordChange: (next: string) => void;
  onAuthStorageModeChange: (next: "local" | "session") => void;
  onLoginGrantInputChange: (next: string) => void;
  onLoginGrantExchange: () => void;
  onSignOut: () => void;
  onUnlockAdvanced: () => void;
  onLockAdvanced: () => void;
  onRevealSecrets: () => void;
  onConnect: () => void;
  onRefresh: () => void;
  onNavigate?: (tab: Tab) => void;
  onOpenAgentTasks?: () => void;
  onOpenAgentSessions?: () => void;
  onOpenAdminControl?: () => void;
  onOpenTaskPayment?: () => void;
  onOpenFederationReview?: () => void;
  onDashboardLayoutChange: (next: DashboardLayout) => void;
  onDashboardWidgetDrawerOpen: (next: boolean) => void;
};

type OverviewTone = "default" | "ok" | "warn" | "danger";

function statusClass(tone: OverviewTone) {
  return `dashboard-metric__value${tone === "default" ? "" : ` ${tone}`}`;
}

function dashboardAgentSummary(agentsList: AgentsListResult | null | undefined) {
  const agents = agentsList?.agents ?? [];
  return {
    count: agents.length,
  };
}

function dashboardTaskSummary(props: OverviewProps) {
  const count = props.cronEnabled ? (props.cronJobs ?? 0) : 0;
  return {
    count,
  };
}

type DashboardFederationStatus = {
  label: "Active" | "Token" | "Expired" | "Invalid" | "Not joined";
  tone: "neutral" | "success" | "warn" | "danger";
};

function readDashboardNumericAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return null;
  }
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function readDashboardSolBalance(wallet: WalletNamedWallet): number {
  const raw = String(wallet.balances?.solana ?? "").trim();
  if (!raw) {
    return 0;
  }
  const numeric = readDashboardNumericAmount(raw);
  if (numeric === null) {
    return 0;
  }
  if (/\bsol\b/i.test(raw) || raw.includes(".")) {
    return numeric;
  }
  if (/lamports/i.test(raw) || /^[+-]?\d+$/.test(raw)) {
    try {
      const integer = raw.match(/[+-]?\d+/)?.[0] ?? "0";
      return Number(BigInt(integer)) / 1_000_000_000;
    } catch {
      return numeric;
    }
  }
  return numeric;
}

function formatDashboardBalance(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  if (value >= 1) {
    return value.toFixed(2).replace(/\.?0+$/, "");
  }
  if (value >= 0.01) {
    return value.toFixed(2).replace(/\.?0+$/, "");
  }
  return "<0.01";
}

function dashboardFederationToken(props: OverviewProps): FederationToken | null {
  return props.federationStatus?.token ?? props.federationToken ?? null;
}

function dashboardFederationStatus(props: OverviewProps): DashboardFederationStatus {
  const lifecycle = props.federationStatus?.lifecycle;
  if (props.federationStatus?.joined && lifecycle === "active") {
    return { label: "Active", tone: "success" };
  }
  if (lifecycle === "expired") {
    return { label: "Expired", tone: "warn" };
  }
  if (lifecycle === "invalid") {
    return { label: "Invalid", tone: "danger" };
  }
  if (dashboardFederationToken(props)) {
    return { label: "Token", tone: "warn" };
  }
  return { label: "Not joined", tone: "neutral" };
}

function shortenDashboardUrlPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 5)}...${trimmed.slice(-4)}`;
}

function dashboardFederationUrlPath(props: OverviewProps): {
  value: string;
  copyValue?: string;
} {
  const token = dashboardFederationToken(props);
  const publicUrl = token?.publicUrl?.trim() ?? "";
  if (publicUrl) {
    try {
      const url = new URL(publicUrl);
      const path =
        url.pathname === "/" ? url.hostname : decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      return { value: shortenDashboardUrlPath(path), copyValue: publicUrl };
    } catch {
      return { value: shortenDashboardUrlPath(publicUrl), copyValue: publicUrl };
    }
  }
  return { value: "Not joined" };
}

type DashboardWidgetDefinition = {
  id: DashboardWidgetId;
  title: string;
  source: string;
  icon: IconName;
  summary: string;
};

const DASHBOARD_WIDGETS: DashboardWidgetDefinition[] = [
  {
    id: "wen",
    title: "WEN",
    source: "wen.economy.read",
    icon: "globe",
    summary: "Economy, acquisitions and approved operations.",
  },
  {
    id: "agents",
    title: "Agents",
    source: "agents.list",
    icon: "folder",
    summary: "Configured Agent workspaces on this node.",
  },
  {
    id: "wallet",
    title: "Wallet",
    source: "wallet.status",
    icon: "wallet",
    summary: "Configured wallets and settlement readiness.",
  },
  {
    id: "network",
    title: "Network",
    source: "federation.status",
    icon: "globe",
    summary: "Agent discovery and collaboration.",
  },
];

const DASHBOARD_WIDGETS_BY_ID = new Map(DASHBOARD_WIDGETS.map((widget) => [widget.id, widget]));
const DASHBOARD_DRAG_MIME = "application/x-fased-dashboard-widget";
const SUMMARY_DASHBOARD_WIDGETS = new Set<DashboardWidgetId>([
  "wen",
  "agents",
  "wallet",
  "network",
]);

function readDashboardDrag(event: DragEvent): DashboardWidgetId | null {
  const raw =
    event.dataTransfer?.getData(DASHBOARD_DRAG_MIME) ||
    event.dataTransfer?.getData("text/plain") ||
    "";
  const value = raw.trim() as DashboardWidgetId;
  return value !== "usage" && DASHBOARD_WIDGETS_BY_ID.has(value) ? value : null;
}

function renderLinkedSummaryCard(
  props: OverviewProps,
  params: {
    tab: Tab;
    title: string;
    value: string | number;
    detail?: string;
    help?: string;
    tone?: OverviewTone;
    href?: string;
    onOpen?: () => void;
  },
) {
  const href = params.href ?? pathForTab(params.tab, props.basePath);
  return html`
    <a
      class="dashboard-summary-card dashboard-metric--link"
      data-tooltip=${params.help ?? ""}
      href=${href}
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          (!props.onNavigate && !params.onOpen)
        ) {
          return;
        }
        event.preventDefault();
        if (params.onOpen) {
          params.onOpen();
          return;
        }
        props.onNavigate?.(params.tab);
      }}
    >
      <div class=${statusClass(params.tone ?? "default")}>${params.value}</div>
      <div class="dashboard-summary-card__title">${params.title}</div>
      ${params.detail ? html`<div class="dashboard-metric__detail">${params.detail}</div>` : nothing}
    </a>
  `;
}

function buildDashboardContext(props: OverviewProps) {
  const statusWallets = new Map(
    (props.walletStatus?.wallets ?? []).map((wallet) => [wallet.id, wallet]),
  );
  const wallets = props.walletNamedWallets?.length
    ? props.walletNamedWallets
    : (props.walletStatus?.wallets ?? []);
  return {
    agents: dashboardAgentSummary(props.agentsList),
    tasks: dashboardTaskSummary(props),
    wallets: [
      {
        count: wallets.length,
        sol: wallets.reduce(
          (total, wallet) =>
            total +
            readDashboardSolBalance({
              ...wallet,
              balances: wallet.balances ?? statusWallets.get(wallet.id)?.balances,
            } as WalletNamedWallet),
          0,
        ),
      },
    ],
    federationStatus: dashboardFederationStatus(props),
    federationUrl: dashboardFederationUrlPath(props),
  };
}

function renderDashboardNetworkCard(props: OverviewProps) {
  const href = pathForTab("federation", props.basePath);
  return html`
    <a
      class="dashboard-network-card dashboard-metric--link"
      href=${href}
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          !props.onNavigate
        ) {
          return;
        }
        event.preventDefault();
        props.onNavigate("federation");
      }}
    >
      <div class="dashboard-summary-card">
        <span class="dashboard-summary-card__title">Agent network</span>
        <p>Discovery and collaboration connections. Network access does not grant wallet permissions.</p>
      </div>
    </a>
  `;
}

function renderWidgetBody(
  props: OverviewProps,
  widgetId: DashboardWidgetId,
  context: ReturnType<typeof buildDashboardContext>,
) {
  switch (widgetId) {
    case "agents":
      return html`
        <div class="dashboard-summary-grid">
          ${renderLinkedSummaryCard(props, {
            tab: "agents",
            title: "Agents",
            value: context.agents.count,
            help: "Configured Agent workspaces available on this gateway.",
          })}
          ${renderLinkedSummaryCard(props, {
            tab: "agents",
            title: "Tasks",
            value: context.tasks.count,
            href: pathForTab("agents", props.basePath),
            onOpen: props.onOpenAgentTasks,
            help: "Saved Task definitions for the selected Agent, with triggers, workflows, graphs, programs, templates, and an opt-in run-history filter.",
          })}
          ${renderLinkedSummaryCard(props, {
            tab: "agents",
            title: "Sessions",
            value: props.sessionsCount ?? 0,
            href: pathForTab("agents", props.basePath),
            onOpen: props.onOpenAgentSessions,
            help: "Total saved chat, channel, and task sessions across all Agents.",
          })}
        </div>
      `;
    case "wen":
      return html`${renderLinkedSummaryCard(props, {
        tab: "wen",
        title: "Open strategy desk",
        value: "WEN",
        detail: "Economy · acquisitions · approved operations",
        help: "Read the configured economy and manage wallet-authorized operations.",
      })}`;
    case "wallet":
      return html`<div class="dashboard-summary-grid dashboard-summary-grid--wallets">
        ${renderLinkedSummaryCard(props, {
          tab: "wallet",
          title: "Wallets",
          value: context.wallets.reduce((total, wallet) => total + wallet.count, 0),
          detail: `${formatDashboardBalance(context.wallets.reduce((total, wallet) => total + wallet.sol, 0))} SOL`,
          help: "Manage wallets, permissions, budgets and approval modes.",
        })}
      </div>`;
    case "network":
      return renderDashboardNetworkCard(props);
    default:
      return nothing;
  }
}

function renderDashboardWidget(
  props: OverviewProps,
  widgetId: DashboardWidgetId,
  context: ReturnType<typeof buildDashboardContext>,
) {
  if (widgetId === "usage") {
    return nothing;
  }
  const definition = DASHBOARD_WIDGETS_BY_ID.get(widgetId);
  if (!definition) {
    return nothing;
  }
  const widgetTitle = widgetId === "network" ? context.federationUrl.value : definition.title;
  return html`
    <article
      class="dashboard-widget"
      @dragover=${(event: DragEvent) => event.preventDefault()}
      @drop=${(event: DragEvent) => {
        event.preventDefault();
        const moving = readDashboardDrag(event);
        if (!moving || moving === widgetId) {
          return;
        }
        props.onDashboardLayoutChange(
          moveDashboardWidget(props.dashboardLayout, moving, "dashboard", widgetId),
        );
      }}
    >
      ${
        SUMMARY_DASHBOARD_WIDGETS.has(widgetId)
          ? html`
            <header
              class="dashboard-widget__header dashboard-widget__header--compact"
              draggable="true"
              @dragstart=${(event: DragEvent) => {
                event.dataTransfer?.setData(DASHBOARD_DRAG_MIME, widgetId);
                event.dataTransfer?.setData("text/plain", widgetId);
                if (event.dataTransfer) {
                  event.dataTransfer.effectAllowed = "move";
                }
              }}
            >
              <span class="dashboard-widget__icon" aria-hidden="true">${icons[definition.icon]}</span>
              <span class="dashboard-widget__title-block">
                <span class="dashboard-widget__title">${widgetTitle}</span>
              </span>
              ${
                widgetId === "network"
                  ? html`
                    <span
                      class="dashboard-status-dot"
                      data-tone=${context.federationStatus.tone}
                      title=${context.federationStatus.label}
                      aria-label=${context.federationStatus.label}
                    ></span>
                  `
                  : nothing
              }
              <span class="dashboard-widget__spacer"></span>
              <span class="dashboard-widget__drag-handle" title="Drag to move" aria-hidden="true">
                ${icons.arrowUpDown}
              </span>
              <button
                class="icon-btn"
                title="Remove widget"
                aria-label="Remove ${widgetTitle}"
                @click=${() =>
                  props.onDashboardLayoutChange(
                    removeDashboardWidget(props.dashboardLayout, widgetId),
                  )}
              >
                ${icons.x}
              </button>
            </header>
          `
          : html`
            <header
              class="dashboard-widget__header"
              draggable="true"
              @dragstart=${(event: DragEvent) => {
                event.dataTransfer?.setData(DASHBOARD_DRAG_MIME, widgetId);
                event.dataTransfer?.setData("text/plain", widgetId);
                if (event.dataTransfer) {
                  event.dataTransfer.effectAllowed = "move";
                }
              }}
            >
              <span class="dashboard-widget__icon" aria-hidden="true">${icons[definition.icon]}</span>
              <span class="dashboard-widget__title-block">
                <span class="dashboard-widget__title">${definition.title}</span>
                <span class="dashboard-widget__source">Source: ${definition.source}</span>
              </span>
              <span class="dashboard-widget__spacer"></span>
              <span class="dashboard-widget__drag-handle" title="Drag to move" aria-hidden="true">
                ${icons.arrowUpDown}
              </span>
              <button
                class="icon-btn"
                title="Remove widget"
                aria-label="Remove ${definition.title}"
                @click=${() =>
                  props.onDashboardLayoutChange(
                    removeDashboardWidget(props.dashboardLayout, widgetId),
                  )}
              >
                ${icons.x}
              </button>
            </header>
          `
      }
      <div class="dashboard-widget__body">${renderWidgetBody(props, widgetId, context)}</div>
    </article>
  `;
}

function renderDashboardDrawer(props: OverviewProps) {
  const active = new Set(dashboardWidgetIds(props.dashboardLayout));
  return props.dashboardWidgetDrawerOpen
    ? html`
        <div
          class="dashboard-drawer-backdrop"
          role="presentation"
          @click=${(event: MouseEvent) => {
            if (event.target === event.currentTarget) {
              props.onDashboardWidgetDrawerOpen(false);
            }
          }}
        >
          <section class="dashboard-drawer" role="dialog" aria-modal="true" aria-label="Dashboard widgets">
            <header class="dashboard-drawer__header">
              <div>
                <div class="dashboard-drawer__title">Widgets</div>
                <div class="dashboard-drawer__sub">Add, remove, or reset dashboard blocks.</div>
              </div>
              <button
                class="icon-btn"
                title="Close widgets"
                aria-label="Close widgets"
                @click=${() => props.onDashboardWidgetDrawerOpen(false)}
              >
                ${icons.x}
              </button>
            </header>
            <div class="dashboard-drawer__list">
              ${DASHBOARD_WIDGETS.filter((widget) => widget.id !== "usage").map((widget) => {
                const enabled = active.has(widget.id);
                return html`
                  <div class="dashboard-drawer__item">
                    <span class="dashboard-widget__icon" aria-hidden="true">${icons[widget.icon]}</span>
                    <span class="dashboard-drawer__item-main">
                      <span class="dashboard-drawer__item-title">${widget.title}</span>
                      <span class="dashboard-drawer__item-sub">${widget.summary}</span>
                    </span>
                    <button
                      class="btn btn--sm"
                      ?disabled=${enabled}
                      @click=${() =>
                        props.onDashboardLayoutChange(
                          addDashboardWidget(props.dashboardLayout, widget.id),
                        )}
                    >
                      ${enabled ? "Added" : "Add"}
                    </button>
                  </div>
                `;
              })}
            </div>
            <footer class="dashboard-drawer__footer">
              <button
                class="btn"
                @click=${() => props.onDashboardLayoutChange(resetDashboardLayout())}
              >
                Reset layout
              </button>
            </footer>
          </section>
        </div>
      `
    : nothing;
}

export function renderOverview(props: OverviewProps) {
  const context = buildDashboardContext(props);
  const dashboardLayout = normalizeDashboardLayout(props.dashboardLayout ?? resetDashboardLayout());
  const widgets = dashboardWidgetIds(dashboardLayout);

  return html`
    <section class="dashboard-shell">
      <div
        class="dashboard-board"
        aria-label="Dashboard widget board"
        @dragover=${(event: DragEvent) => event.preventDefault()}
        @drop=${(event: DragEvent) => {
          event.preventDefault();
          const moving = readDashboardDrag(event);
          if (!moving) {
            return;
          }
          props.onDashboardLayoutChange(
            moveDashboardWidget(props.dashboardLayout, moving, "dashboard"),
          );
        }}
      >
        ${widgets.map((widgetId) => renderDashboardWidget(props, widgetId, context))}
      </div>

      ${props.lastError ? html`<div class="callout warn">${props.lastError}</div>` : nothing}
      ${props.authNotice ? html`<div class="callout">${props.authNotice}</div>` : nothing}
      ${renderDashboardDrawer(props)}
    </section>
  `;
}
