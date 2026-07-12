import { html, nothing } from "lit";
import {
  addDashboardWidget,
  dashboardWidgetIds,
  moveDashboardWidget,
  removeDashboardWidget,
  resetDashboardLayout,
  type DashboardLayout,
  type DashboardWidgetId,
} from "../dashboard-layout.ts";
import type { FederationStatus, FederationToken } from "../federation-api.ts";
import type { GatewayHelloOk } from "../gateway.ts";
import { icons, type IconName } from "../icons.ts";
import type {
  SatMinerProfile,
  SatMiningHistory,
  SatMiningHistoryPoint,
  SatMiningReadiness,
  SatMiningRuntimeStatus,
} from "../mining-api.ts";
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
  miningAttachedWalletId?: string | null;
  miningProfile?: SatMinerProfile | null;
  miningReadiness?: SatMiningReadiness | null;
  miningStatus?: SatMiningRuntimeStatus | null;
  miningHistory?: SatMiningHistory | null;
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
  onOpenMining?: () => void;
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

function formatDashboardTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "0";
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return String(Math.round(tokens));
}

function dashboardTaskSummary(props: OverviewProps) {
  const count = props.cronEnabled ? (props.cronJobs ?? 0) : 0;
  return {
    count,
  };
}

function dashboardUsageSummary(props: OverviewProps) {
  const daily = dashboardUsageDaily(props.usageResult);
  const totalTokens =
    daily.length > 0
      ? daily.reduce((sum, day) => sum + day.tokens, 0)
      : (props.usageResult?.totals.totalTokens ?? 0);
  return {
    value: props.usageLoading && !props.usageResult ? "..." : formatDashboardTokens(totalTokens),
  };
}

function dashboardUsageDaily(result: SessionsUsageResult | null | undefined) {
  const daily = result?.aggregates.daily ?? [];
  return daily.slice(-7).map((day) => ({
    date: day.date,
    tokens: Number.isFinite(day.tokens) ? Math.max(0, day.tokens) : 0,
    messages: Number.isFinite(day.messages) ? Math.max(0, day.messages) : 0,
    toolCalls: Number.isFinite(day.toolCalls) ? Math.max(0, day.toolCalls) : 0,
  }));
}

type DashboardWalletRole = "agent" | "mining" | "vault";

type DashboardWalletRoleSummary = {
  role: DashboardWalletRole;
  title: string;
  count: number;
  sol: number;
  help: string;
};

type DashboardMiningStatus = {
  label: "Started" | "Ready" | "Stopped" | "Blocked";
  tone: "neutral" | "success" | "warn" | "danger";
};

type DashboardFederationStatus = {
  label: "Active" | "Token" | "Expired" | "Invalid" | "Not joined";
  tone: "neutral" | "success" | "warn" | "danger";
};

function normalizeDashboardWalletRole(value: unknown): DashboardWalletRole | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return raw === "agent" || raw === "mining" || raw === "vault" ? raw : null;
}

function resolveDashboardWalletRole(
  wallet: WalletNamedWallet,
  props: Pick<OverviewProps, "defaultWalletId" | "miningAttachedWalletId">,
): DashboardWalletRole {
  const metadataRole =
    normalizeDashboardWalletRole(wallet.metadata?.purpose) ??
    normalizeDashboardWalletRole(wallet.metadata?.role);
  if (metadataRole === "mining" || wallet.id === String(props.miningAttachedWalletId ?? "")) {
    return "mining";
  }
  if (metadataRole === "vault") {
    return "vault";
  }
  if (metadataRole === "agent" || wallet.id === String(props.defaultWalletId ?? "")) {
    return "agent";
  }
  return "agent";
}

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

function dashboardRawAmountToNumber(raw: string | null | undefined, decimals: number): number {
  const value = String(raw ?? "").trim();
  if (!value) {
    return 0;
  }
  try {
    return Number(BigInt(value)) / 10 ** decimals;
  } catch {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}

function formatDashboardMiningAmount(
  raw: string | null | undefined,
  decimals: number,
  unit: "SOL" | "SAT",
): string {
  const value = dashboardRawAmountToNumber(raw, decimals);
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  if (unit === "SOL") {
    if (value >= 1) {
      return value.toFixed(3).replace(/\.?0+$/, "");
    }
    if (value >= 0.01) {
      return value.toFixed(3).replace(/\.?0+$/, "");
    }
    return "<0.01";
  }
  if (value >= 1) {
    return value.toFixed(2).replace(/\.?0+$/, "");
  }
  if (value >= 0.01) {
    return value.toFixed(3).replace(/\.?0+$/, "");
  }
  return "<0.01";
}

function hasPositiveDashboardRawAmount(raw: string | null | undefined): boolean {
  const value = String(raw ?? "").trim();
  if (!value) {
    return false;
  }
  try {
    return BigInt(value) > 0n;
  } catch {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0;
  }
}

function firstPositiveDashboardRawAmount(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (hasPositiveDashboardRawAmount(value)) {
      return String(value);
    }
  }
  return String(values.find((value) => String(value ?? "").trim().length > 0) ?? "0");
}

function dashboardMiningStatus(props: OverviewProps): DashboardMiningStatus {
  if (props.miningStatus?.blocked) {
    return { label: "Blocked", tone: "danger" };
  }
  if (
    (props.miningStatus?.running || props.miningStatus?.enabledWanted) &&
    !props.miningStatus?.drainOnly
  ) {
    return { label: "Started", tone: "success" };
  }
  if (props.miningReadiness?.ok || props.miningProfile?.walletId || props.miningStatus) {
    return { label: "Ready", tone: "success" };
  }
  return { label: "Stopped", tone: "neutral" };
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
  const publicUrl =
    token?.publicUrl?.trim() ?? props.federationStatus?.hostedProbe?.publicUrl?.trim() ?? "";
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

function dashboardFederationBondRaw(props: OverviewProps): string {
  const token = dashboardFederationToken(props);
  return props.federationStatus?.bond?.amountRaw ?? token?.bondAmountRaw ?? "0";
}

function dashboardFederationClaimRaw(props: OverviewProps): string {
  const position = props.federationStatus?.bond?.staking?.position;
  return position?.estimatedClaimableRewardRaw ?? position?.claimableRewardRaw ?? "0";
}

function dashboardMiningSatRaw(props: OverviewProps): string {
  return firstPositiveDashboardRawAmount(
    props.miningStatus?.currentSatBalanceRaw,
    props.miningReadiness?.balances.satBalanceRaw,
  );
}

function dashboardMiningCapitalFundedRaw(props: OverviewProps): string {
  return firstPositiveDashboardRawAmount(
    props.miningStatus?.currentCapitalFundedLamports,
    props.miningReadiness?.balances.minerCapitalFundedLamports,
    props.miningStatus?.currentCapitalLockedLamports,
    props.miningReadiness?.balances.minerCapitalLockedLamports,
  );
}

function dashboardMiningCapitalLockedRaw(props: OverviewProps): string {
  return firstPositiveDashboardRawAmount(
    props.miningStatus?.currentCapitalLockedLamports,
    props.miningReadiness?.balances.minerCapitalLockedLamports,
  );
}

function dashboardMiningCapitalDetail(props: OverviewProps): string | undefined {
  const locked = dashboardMiningCapitalLockedRaw(props);
  if (!hasPositiveDashboardRawAmount(locked)) {
    return undefined;
  }
  return `${formatDashboardMiningAmount(locked, 9, "SOL")} locked`;
}

function dashboardMiningHistoryPoints(
  history: SatMiningHistory | null | undefined,
): SatMiningHistoryPoint[] {
  const points = history?.outcomes?.length ? history.outcomes : (history?.activityOutcomes ?? []);
  return points.slice(-14);
}

function renderMiningSatHistory(history: SatMiningHistory | null | undefined) {
  const points = dashboardMiningHistoryPoints(history);
  const values = points.map((point) => dashboardRawAmountToNumber(point.totalSatEarnedRaw, 11));
  const max = Math.max(...values, 0);
  return html`
    <div class="dashboard-mining-history">
      <div class="dashboard-mining-history__head">
        <span>7d SAT</span>
        <span>${points.length ? `${points.length} cycles` : "No history"}</span>
      </div>
      <div class="dashboard-mining-bars" aria-label="7 day SAT mining history">
        ${
          points.length
            ? points.map((point, index) => {
                const value = values[index] ?? 0;
                const height = max > 0 ? Math.max(8, Math.round((value / max) * 100)) : 8;
                return html`
                  <span
                    class="dashboard-mining-bars__bar"
                    data-tooltip=${`7d cycle ${point.cycleId}: ${formatDashboardBalance(value)} SAT`}
                    style=${`height:${height}%`}
                  ></span>
                `;
              })
            : html`
                <span class="dashboard-mining-bars__empty"></span>
              `
        }
      </div>
    </div>
  `;
}

function renderUsageHistory(result: SessionsUsageResult | null | undefined) {
  const points = dashboardUsageDaily(result);
  const max = Math.max(...points.map((point) => point.tokens), 0);
  return html`
    <div class="dashboard-usage-history">
      <div class="dashboard-usage-history__head">
        <span>7d tokens</span>
        <span>${points.length ? `${points.length} days` : "No usage"}</span>
      </div>
      <div class="dashboard-usage-bars" aria-label="7 day token usage">
        ${
          points.length
            ? points.map((point) => {
                const height = max > 0 ? Math.max(8, Math.round((point.tokens / max) * 100)) : 8;
                return html`
                  <span
                    class="dashboard-usage-bars__bar"
                    data-tooltip=${`7d ${point.date}: ${formatDashboardTokens(point.tokens)} tokens`}
                    style=${`height:${height}%`}
                  ></span>
                `;
              })
            : html`
                <span class="dashboard-usage-bars__empty"></span>
              `
        }
      </div>
    </div>
  `;
}

function dashboardWalletRoleSummary(props: OverviewProps): DashboardWalletRoleSummary[] {
  const statusWallets = new Map(
    (props.walletStatus?.wallets ?? []).map((wallet) => [wallet.id, wallet]),
  );
  const namedWallets = props.walletNamedWallets ?? [];
  const wallets = namedWallets.length > 0 ? namedWallets : (props.walletStatus?.wallets ?? []);
  const summaries: Record<DashboardWalletRole, DashboardWalletRoleSummary> = {
    agent: {
      role: "agent",
      title: "Agent",
      count: 0,
      sol: 0,
      help: "Agent wallets are regular wallets available to Agents only when wallet policy and grants allow them.",
    },
    mining: {
      role: "mining",
      title: "Mining",
      count: 0,
      sol: 0,
      help: "Mining wallets are dedicated to SAT mining capital and should stay separate from Agent wallets.",
    },
    vault: {
      role: "vault",
      title: "Vault",
      count: 0,
      sol: 0,
      help: "Vault wallets are protected storage. They are not available to skills or mining automation.",
    },
  };
  for (const wallet of wallets) {
    const mergedWallet = {
      ...wallet,
      balances: wallet.balances ?? statusWallets.get(wallet.id)?.balances,
    } as WalletNamedWallet;
    const role = resolveDashboardWalletRole(mergedWallet, props);
    summaries[role].count += 1;
    summaries[role].sol += readDashboardSolBalance(mergedWallet);
  }
  return [summaries.agent, summaries.mining, summaries.vault];
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
    id: "agents",
    title: "Agents",
    source: "agents.list",
    icon: "folder",
    summary: "Configured Agent workspaces on this node.",
  },
  {
    id: "usage",
    title: "Usage",
    source: "sessions.usage",
    icon: "barChart",
    summary: "Total recorded model usage across all Agents.",
  },
  {
    id: "wallet",
    title: "Wallet",
    source: "wallet.status",
    icon: "wallet",
    summary: "Configured wallets and settlement readiness.",
  },
  {
    id: "mining",
    title: "Mining",
    source: "sat.mining.status",
    icon: "zap",
    summary: "Mining runtime state and next operator action.",
  },
  {
    id: "network",
    title: "Network",
    source: "federation.status",
    icon: "globe",
    summary: "Directory, attestation, marketplace, and join state.",
  },
];

const DASHBOARD_WIDGETS_BY_ID = new Map(DASHBOARD_WIDGETS.map((widget) => [widget.id, widget]));
const DASHBOARD_DRAG_MIME = "application/x-fased-dashboard-widget";
const SUMMARY_DASHBOARD_WIDGETS = new Set<DashboardWidgetId>([
  "agents",
  "usage",
  "wallet",
  "mining",
  "network",
]);

function readDashboardDrag(event: DragEvent): DashboardWidgetId | null {
  const raw =
    event.dataTransfer?.getData(DASHBOARD_DRAG_MIME) ||
    event.dataTransfer?.getData("text/plain") ||
    "";
  const value = raw.trim() as DashboardWidgetId;
  return DASHBOARD_WIDGETS_BY_ID.has(value) ? value : null;
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
  const agents = dashboardAgentSummary(props.agentsList);
  const tasks = dashboardTaskSummary(props);
  const usage = dashboardUsageSummary(props);
  const wallets = dashboardWalletRoleSummary(props);
  const miningStatus = dashboardMiningStatus(props);
  const miningSatcoin = formatDashboardMiningAmount(dashboardMiningSatRaw(props), 11, "SAT");
  const miningCapital = formatDashboardMiningAmount(
    dashboardMiningCapitalFundedRaw(props),
    9,
    "SOL",
  );
  const miningCapitalDetail = dashboardMiningCapitalDetail(props);
  const federationStatus = dashboardFederationStatus(props);
  const federationUrl = dashboardFederationUrlPath(props);
  const federationBond = formatDashboardMiningAmount(dashboardFederationBondRaw(props), 11, "SAT");
  const federationClaim = formatDashboardMiningAmount(
    dashboardFederationClaimRaw(props),
    11,
    "SAT",
  );
  return {
    agents,
    federationBond,
    federationClaim,
    federationStatus,
    federationUrl,
    miningCapital,
    miningCapitalDetail,
    miningSatcoin,
    miningStatus,
    tasks,
    usage,
    wallets,
  };
}

function renderDashboardNetworkCard(
  props: OverviewProps,
  context: ReturnType<typeof buildDashboardContext>,
) {
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
      <div class="dashboard-network-card__metrics dashboard-summary-grid">
        <span class="dashboard-network-card__metric dashboard-summary-card">
          <span class=${statusClass("default")}>${context.federationBond}</span>
          <span class="dashboard-summary-card__title">Bond</span>
        </span>
        <span class="dashboard-network-card__metric dashboard-summary-card">
          <span class=${statusClass("default")}>${context.federationClaim}</span>
          <span class="dashboard-summary-card__title">Claim</span>
        </span>
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
    case "usage":
      return html`
        ${renderLinkedSummaryCard(props, {
          tab: "usage",
          title: "Tokens",
          value: context.usage.value,
          help: "7d model tokens from the local usage ledger across chats, tasks, channels, and system runs.",
        })}
        ${renderUsageHistory(props.usageResult)}
      `;
    case "wallet":
      return html`
        <div class="dashboard-summary-grid dashboard-summary-grid--wallets">
          ${context.wallets.map((summary) =>
            renderLinkedSummaryCard(props, {
              tab: "wallet",
              title: summary.title,
              value: summary.count,
              detail: `${formatDashboardBalance(summary.sol)} SOL`,
              help: summary.help,
            }),
          )}
        </div>
      `;
    case "mining":
      return html`
        <div class="dashboard-summary-grid dashboard-summary-grid--mining">
          ${renderLinkedSummaryCard(props, {
            tab: "mining",
            title: "SAT",
            value: context.miningSatcoin,
            help: "Current SAT token balance for the configured Mining wallet.",
          })}
          ${renderLinkedSummaryCard(props, {
            tab: "mining",
            title: "Capital",
            value: context.miningCapital,
            detail: context.miningCapitalDetail,
            help: "Total SOL funded in miner capital. Locked capital is shown underneath when cycles are pending or live.",
          })}
        </div>
        ${renderMiningSatHistory(props.miningHistory)}
      `;
    case "network":
      return renderDashboardNetworkCard(props, context);
    default:
      return nothing;
  }
}

function renderDashboardWidget(
  props: OverviewProps,
  widgetId: DashboardWidgetId,
  context: ReturnType<typeof buildDashboardContext>,
) {
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
                widgetId === "mining"
                  ? html`
                    <span
                      class="dashboard-status-dot"
                      data-tone=${context.miningStatus.tone}
                      title=${context.miningStatus.label}
                      aria-label=${context.miningStatus.label}
                    ></span>
                  `
                  : nothing
              }
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
              ${DASHBOARD_WIDGETS.map((widget) => {
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
  const dashboardLayout = props.dashboardLayout ?? resetDashboardLayout();
  const widgets = dashboardWidgetIds(dashboardLayout);

  return html`
    <section class="dashboard-shell">
      ${
        props.hello?.server?.version
          ? html`<div class="muted" data-testid="gateway-runtime-identity">
            Gateway ${props.hello.server.version}
            ${
              props.hello.server.runtimeSource
                ? ` · ${props.hello.server.runtimeSource.replaceAll("-", " ")}`
                : ""
            }
          </div>`
          : nothing
      }
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
