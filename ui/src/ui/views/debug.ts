import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { EventLogEntry } from "../app-events.ts";
import type {
  FederationOperatorEconomyFeeBucketBalanceView,
  FederationOperatorEconomyFeeBucketJournalRow,
  FederationOperatorEconomyFeeCollectionStatus,
  FederationOperatorEconomyFeeObjectRecord,
  FederationOperatorEconomyFeeReconciliationReport,
  FederationOperatorEconomyAutoFeeDecisionRecord,
} from "../federation-api.ts";
import { formatEventPayload } from "../presenter.ts";
import type {
  CommandsListResult,
  DiagnosticStabilitySnapshot,
  DoctorMemoryInventoryPayload,
  DoctorMemoryRepairPreviewPayload,
  DoctorMemoryValidationPayload,
  ModelsCatalogStatusResult,
  PluginsMarketplaceListResult,
  TaskAuditFinding,
  TaskListResult,
} from "../types.ts";

export type DebugAdminRpcAction =
  | "chat.inject"
  | "doctor.memory.repair.execute"
  | "push.test"
  | "web.login.start"
  | "web.login.wait";

export type DebugAcpxBridgeConfigAction =
  | "disable"
  | "status-only"
  | "read-only-tools"
  | "enable-push-test"
  | "deny-push-test";

export type DebugAcpxPushTestAction = "preview" | "execute";

export type DebugAcpxPushTestPreviewPayload = {
  schemaVersion: 1;
  kind: "acpx.mutating-wrapper.push-test.preview";
  wrapperId: "fased_push_test_request";
  method: "push.test";
  requestId: string;
  response: {
    status: "admitted" | "denied";
    stage: "request" | "operator-approval" | "runtime-gate" | "admitted";
    requestFingerprint: string;
    reasons: string[];
    safeSummary: {
      nodeId: string | null;
      environment: "sandbox" | "production" | null;
      titleProvided: boolean;
      bodyProvided: boolean;
    };
  };
};

export type DebugAcpxPushTestAuditHistoryPayload = {
  schemaVersion: 1;
  kind: "acpx.mutating-wrapper.push-test.audit-history";
  wrapperId: "fased_push_test_request";
  method: "push.test";
  generatedAt: string;
  capacity: number;
  count: number;
  dropped: number;
  firstSeq?: number;
  lastSeq?: number;
  events: Array<{
    seq: number;
    ts: number;
    method: "push.test";
    outcome: "succeeded" | "failed" | "denied";
    actor: string;
    deviceId: string;
    clientIp: string;
    connId: string;
    details: Record<string, string>;
  }>;
};

export type DebugProps = {
  loading: boolean;
  status: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
  models: unknown[];
  configForm?: Record<string, unknown> | null;
  configSaving?: boolean;
  configDirty?: boolean;
  modelCatalogStatus?: ModelsCatalogStatusResult | null;
  commandsCatalog?: CommandsListResult | null;
  pluginsMarketplace?: PluginsMarketplaceListResult | null;
  taskLedger?: TaskListResult | null;
  taskLedgerBusy?: boolean;
  taskLedgerError?: string | null;
  taskLedgerMaintenanceMessage?: string | null;
  diagnosticsStability?: DiagnosticStabilitySnapshot | null;
  memoryInventory?: DoctorMemoryInventoryPayload | null;
  memoryValidation?: DoctorMemoryValidationPayload | null;
  memoryRepairPreview?: DoctorMemoryRepairPreviewPayload | null;
  heartbeat: unknown;
  eventLog: EventLogEntry[];
  methods: string[];
  callMethod: string;
  callParams: string;
  callResult: string | null;
  callError: string | null;
  adminRpcBusy: string | null;
  adminRpcResult: string | null;
  adminRpcError: string | null;
  adminChatSessionKey: string;
  adminChatMessage: string;
  adminPushNodeId: string;
  adminPushTitle: string;
  adminPushBody: string;
  adminWebAccountId: string;
  acpxBridgeConfigBusy?: DebugAcpxBridgeConfigAction | null;
  acpxBridgeConfigResult?: string | null;
  acpxBridgeConfigError?: string | null;
  acpxPushTestBusy?: DebugAcpxPushTestAction | null;
  acpxPushTestPreview?: DebugAcpxPushTestPreviewPayload | null;
  acpxPushTestAuditHistory?: DebugAcpxPushTestAuditHistoryPayload | null;
  acpxPushTestResult?: string | null;
  acpxPushTestError?: string | null;
  satProtocolMaintenanceBusy?: boolean;
  satProtocolMaintenanceResult?: string | null;
  satProtocolMaintenanceError?: string | null;
  feeOpsLoading?: boolean;
  feeOpsError?: string | null;
  feeCollectionStatus?: FederationOperatorEconomyFeeCollectionStatus[];
  feeObjects?: FederationOperatorEconomyFeeObjectRecord[];
  feeBucketJournal?: FederationOperatorEconomyFeeBucketJournalRow[];
  feeBucketBalances?: FederationOperatorEconomyFeeBucketBalanceView[];
  feeReconciliationReports?: FederationOperatorEconomyFeeReconciliationReport[];
  feeAutoDecisions?: FederationOperatorEconomyAutoFeeDecisionRecord[];
  onCallMethodChange: (next: string) => void;
  onCallParamsChange: (next: string) => void;
  onAdminChatSessionKeyChange: (next: string) => void;
  onAdminChatMessageChange: (next: string) => void;
  onAdminPushNodeIdChange: (next: string) => void;
  onAdminPushTitleChange: (next: string) => void;
  onAdminPushBodyChange: (next: string) => void;
  onAdminWebAccountIdChange: (next: string) => void;
  onRefresh: () => void;
  onCall: () => void;
  onConfigPatch?: (path: Array<string | number>, value: unknown) => void;
  onConfigSave?: () => void;
  onConfigReload?: () => void;
  onTaskLedgerMaintenance?: (opts?: {
    cleanupOrphanedCronRuns?: boolean;
    staleRunningMs?: number;
  }) => void;
  onAdminRpcAction: (action: DebugAdminRpcAction) => void;
  onAcpxBridgeConfigAction?: (action: DebugAcpxBridgeConfigAction) => void;
  onAcpxPushTestAction?: (action: DebugAcpxPushTestAction) => void;
  onSatProtocolMaintenance?: () => void;
};

function formatFeeThresholds(status: FederationOperatorEconomyFeeCollectionStatus): string {
  const required = status.thresholds;
  const observed = status.observed;
  return [
    `history ${observed.historyDaysObserved}/${required.historyDays}d`,
    `marketplace ${observed.marketplaceRunsObserved}/${required.marketplaceRuns}`,
    `notary ${observed.disputeNotaryCasesObserved}/${required.disputeNotaryCases}`,
    `verifier ${observed.settlementVerifierCasesObserved}/${required.settlementVerifierCases}`,
    `routing ${observed.routingRunsObserved}/${required.routingRuns}`,
  ].join(" · ");
}

type GatewayStartupView = {
  entries: Array<{ name: string; durationMs: number }>;
  totalMs: number;
  summary: string;
  recordedAtMs: number;
};

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "unknown";
  }
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.max(0, Math.round(ms))}ms`;
}

function readGatewayStartup(status: Record<string, unknown> | null): GatewayStartupView | null {
  const value = status?.gatewayStartup;
  if (!value || typeof value !== "object") {
    return null;
  }
  const startup = value as Partial<GatewayStartupView>;
  const entries = Array.isArray(startup.entries)
    ? startup.entries
        .filter(
          (entry): entry is { name: string; durationMs: number } =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof (entry as { name?: unknown }).name === "string" &&
            typeof (entry as { durationMs?: unknown }).durationMs === "number",
        )
        .map((entry) => ({ name: entry.name, durationMs: entry.durationMs }))
    : [];
  return {
    entries,
    totalMs: typeof startup.totalMs === "number" ? startup.totalMs : 0,
    summary: typeof startup.summary === "string" ? startup.summary : "",
    recordedAtMs: typeof startup.recordedAtMs === "number" ? startup.recordedAtMs : 0,
  };
}

function countCommandsBySource(commandsCatalog: CommandsListResult | null | undefined) {
  const counts: Record<string, number> = {};
  for (const command of commandsCatalog?.commands ?? []) {
    counts[command.source] = (counts[command.source] ?? 0) + 1;
  }
  return Object.entries(counts).toSorted(([left], [right]) => left.localeCompare(right));
}

function formatTimestamp(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return "unknown";
  }
  return new Date(ms).toLocaleString();
}

function formatIdList(values: readonly string[] | undefined, empty = "none"): string {
  const cleaned = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return empty;
  }
  if (cleaned.length <= 6) {
    return cleaned.join(", ");
  }
  return `${cleaned.slice(0, 6).join(", ")} +${cleaned.length - 6} more`;
}

type AcpxBridgeStatusView = {
  enabled: boolean;
  mode: string;
  allowTools: string[];
  denyTools: string[];
  fasedPushTestRequest: {
    enabled: boolean;
    reason: string;
  };
};

type StrictAgenticPolicyStatusView = {
  mode: "off" | "warn";
  source: string;
  envFlagSet: boolean;
  enforcementAvailable: boolean;
  warningAgents: number;
  totalAgents: number;
  agents: Array<{
    agentId: string;
    mode: "off" | "warn";
    source: string;
    override: boolean;
  }>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];
}

function readAcpxBridgeStatus(status: Record<string, unknown> | null): AcpxBridgeStatusView {
  const bridge = asRecord(status?.acpxMcpBridge);
  const pushTest = asRecord(bridge.fasedPushTestRequest);
  return {
    enabled: bridge.enabled === true,
    mode: typeof bridge.mode === "string" ? bridge.mode : "disabled",
    allowTools: readStringList(bridge.allowTools),
    denyTools: readStringList(bridge.denyTools),
    fasedPushTestRequest: {
      enabled: pushTest.enabled === true,
      reason: typeof pushTest.reason === "string" ? pushTest.reason : "unknown",
    },
  };
}

function readStrictAgenticStatus(
  status: Record<string, unknown> | null,
): StrictAgenticPolicyStatusView | null {
  const policy = asRecord(status?.strictAgentic);
  if (Object.keys(policy).length === 0) {
    return null;
  }
  const agents = Array.isArray(policy.agents)
    ? policy.agents
        .map((entry) => {
          const item = asRecord(entry);
          const agentId =
            typeof item.agentId === "string" && item.agentId.trim() ? item.agentId.trim() : null;
          return agentId
            ? {
                agentId,
                mode: item.mode === "warn" ? "warn" : ("off" as const),
                source: typeof item.source === "string" ? item.source : "unknown",
                override: item.override === true,
              }
            : null;
        })
        .filter(
          (
            entry,
          ): entry is {
            agentId: string;
            mode: "off" | "warn";
            source: string;
            override: boolean;
          } => entry != null,
        )
    : [];
  return {
    mode: policy.mode === "warn" ? "warn" : "off",
    source: typeof policy.source === "string" ? policy.source : "unknown",
    envFlagSet: policy.envFlagSet === true,
    enforcementAvailable: policy.enforcementAvailable === true,
    warningAgents:
      typeof policy.warningAgents === "number" && Number.isFinite(policy.warningAgents)
        ? Math.max(0, Math.floor(policy.warningAgents))
        : agents.filter((agent) => agent.mode === "warn").length,
    totalAgents:
      typeof policy.totalAgents === "number" && Number.isFinite(policy.totalAgents)
        ? Math.max(0, Math.floor(policy.totalAgents))
        : agents.length,
    agents,
  };
}

function renderAcpxBridgeConfigControls(props: DebugProps) {
  const status = readAcpxBridgeStatus(props.status);
  const busy = props.acpxBridgeConfigBusy;
  const buttonLabel = (action: DebugAcpxBridgeConfigAction, idle: string) =>
    busy === action ? "Saving..." : idle;
  return html`
    <div class="card">
      <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
        <div>
          <div class="card-title">ACPX Bridge Config</div>
          <div class="card-sub">
            Admin-only controls for the Fased-owned MCP bridge. Mutating wrappers stay disabled unless
            explicitly allowlisted here and admitted by the runtime approval gate.
          </div>
        </div>
        <span class="chip ${status.fasedPushTestRequest.enabled ? "chip-warn" : status.enabled ? "chip-ok" : ""}">
          ${
            status.fasedPushTestRequest.enabled
              ? "operator-approved"
              : status.enabled
                ? status.mode
                : "disabled"
          }
        </span>
      </div>
      <div class="chip-row" style="margin-top: 12px;">
        <span class="chip">mode ${status.mode}</span>
        <span class="chip">allow ${formatIdList(status.allowTools)}</span>
        <span class="chip">deny ${formatIdList(status.denyTools)}</span>
        <span class="chip ${status.fasedPushTestRequest.enabled ? "chip-warn" : ""}">
          fased_push_test_request ${status.fasedPushTestRequest.enabled ? "enabled" : "disabled"}
        </span>
        <span class="chip">reason ${status.fasedPushTestRequest.reason}</span>
      </div>
      ${
        props.acpxBridgeConfigError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.acpxBridgeConfigError}</div>`
          : nothing
      }
      ${
        props.acpxBridgeConfigResult
          ? html`<pre class="code-block" style="margin-top: 12px;">${props.acpxBridgeConfigResult}</pre>`
          : nothing
      }
      <div class="callout warn" style="margin-top: 12px;">
        Enabling <span class="mono">fased_push_test_request</span> changes config and schedules a gateway
        restart. The tool still requires local bridge token auth, operator approval, rate-limit, and audit.
      </div>
      <div class="row" style="gap: 8px; flex-wrap: wrap; margin-top: 12px;">
        <button
          class="btn"
          ?disabled=${Boolean(busy) || !props.onAcpxBridgeConfigAction}
          @click=${() => props.onAcpxBridgeConfigAction?.("disable")}
        >
          ${buttonLabel("disable", "Disable bridge")}
        </button>
        <button
          class="btn"
          ?disabled=${Boolean(busy) || !props.onAcpxBridgeConfigAction}
          @click=${() => props.onAcpxBridgeConfigAction?.("status-only")}
        >
          ${buttonLabel("status-only", "Status only")}
        </button>
        <button
          class="btn"
          ?disabled=${Boolean(busy) || !props.onAcpxBridgeConfigAction}
          @click=${() => props.onAcpxBridgeConfigAction?.("read-only-tools")}
        >
          ${buttonLabel("read-only-tools", "Read-only tools")}
        </button>
        <button
          class="btn danger"
          ?disabled=${Boolean(busy) || !props.onAcpxBridgeConfigAction}
          @click=${() => props.onAcpxBridgeConfigAction?.("enable-push-test")}
        >
          ${buttonLabel("enable-push-test", "Enable push-test wrapper")}
        </button>
        <button
          class="btn"
          ?disabled=${Boolean(busy) || !props.onAcpxBridgeConfigAction}
          @click=${() => props.onAcpxBridgeConfigAction?.("deny-push-test")}
        >
          ${buttonLabel("deny-push-test", "Deny push-test wrapper")}
        </button>
      </div>
    </div>
  `;
}

function shortFingerprint(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "none";
  }
  return trimmed.length <= 20 ? trimmed : `${trimmed.slice(0, 16)}...${trimmed.slice(-8)}`;
}

function formatAcpxAuditTimestamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) {
    return "unknown";
  }
  return new Date(ts).toLocaleTimeString();
}

function formatAcpxAuditDetails(details: Record<string, string>): string {
  const entries = Object.entries(details)
    .filter(([key]) => key.trim().length > 0)
    .toSorted(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return "sanitized audit event";
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(" · ");
}

function renderAcpxPushTestApprovalCard(props: DebugProps) {
  const status = readAcpxBridgeStatus(props.status);
  const preview = props.acpxPushTestPreview ?? null;
  const response = preview?.response ?? null;
  const safeSummary = response?.safeSummary ?? null;
  const pushEnabled = status.fasedPushTestRequest.enabled;
  const busy = props.acpxPushTestBusy;
  const auditHistory = props.acpxPushTestAuditHistory ?? null;
  const auditEvents = auditHistory?.events.toReversed().slice(0, 6) ?? [];
  const canExecute =
    pushEnabled &&
    Boolean(response?.requestFingerprint) &&
    !busy &&
    Boolean(props.onAcpxPushTestAction);
  return html`
    <div class="card">
      <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
        <div>
          <div class="card-title">ACPX Push-Test Approval</div>
          <div class="card-sub">
            Fixed-wrapper approval and result state for <span class="mono">fased_push_test_request</span>.
            This does not expose a generic MCP or gateway dispatcher.
          </div>
        </div>
        <span class="chip ${pushEnabled ? "chip-warn" : ""}">
          ${pushEnabled ? "wrapper enabled" : "wrapper disabled"}
        </span>
      </div>
      <div class="grid two" style="margin-top: 12px;">
        <label>
          <span>Node id</span>
          <input
            .value=${props.adminPushNodeId}
            @input=${(event: Event) =>
              props.onAdminPushNodeIdChange((event.target as HTMLInputElement).value)}
            placeholder="ios-node-1"
          />
        </label>
        <label>
          <span>Title</span>
          <input
            .value=${props.adminPushTitle}
            @input=${(event: Event) =>
              props.onAdminPushTitleChange((event.target as HTMLInputElement).value)}
            placeholder="Fased test push"
          />
        </label>
      </div>
      <label style="display: block; margin-top: 8px;">
        <span>Body</span>
        <input
          .value=${props.adminPushBody}
          @input=${(event: Event) =>
            props.onAdminPushBodyChange((event.target as HTMLInputElement).value)}
          placeholder="Operator test push"
        />
      </label>
      <div class="chip-row" style="margin-top: 12px;">
        <span class="chip">bridge ${status.mode}</span>
        <span class="chip ${pushEnabled ? "chip-warn" : ""}">
          fased_push_test_request ${pushEnabled ? "allowlisted" : "not allowlisted"}
        </span>
        <span class="chip">approval ${response?.stage ?? "not previewed"}</span>
        <span class="chip ${response?.status === "admitted" ? "chip-ok" : response ? "chip-warn" : ""}">
          ${response?.status ?? "pending preview"}
        </span>
      </div>
      ${
        response
          ? html`
              <div class="list" style="margin-top: 12px;">
                <div class="list-item">
                  <div class="list-main">
                    <div class="list-title">
                      Request fingerprint
                      <span class="chip">operator approval bound</span>
                    </div>
                    <div class="list-sub mono">${shortFingerprint(response.requestFingerprint)}</div>
                  </div>
                  <div class="list-meta">${response.stage}</div>
                </div>
                <div class="list-item">
                  <div class="list-main">
                    <div class="list-title">Safe summary</div>
                    <div class="list-sub">
                      node ${safeSummary?.nodeId ?? "none"} · env ${safeSummary?.environment ?? "default"} ·
                      title ${safeSummary?.titleProvided ? "provided" : "default"} · body
                      ${safeSummary?.bodyProvided ? "provided" : "default"}
                    </div>
                  </div>
                  <div class="list-meta">redacted</div>
                </div>
                ${
                  response.reasons.length > 0
                    ? html`
                        <div class="list-item">
                          <div class="list-main">
                            <div class="list-title">Current gate reasons</div>
                            <div class="list-sub">${response.reasons.join(" · ")}</div>
                          </div>
                          <div class="list-meta">blocked</div>
                        </div>
                      `
                    : nothing
                }
              </div>
            `
          : html`
              <div class="muted" style="margin-top: 12px">
                Preview builds the sanitized approval contract and fingerprint. It does not send a push.
              </div>
            `
      }
      ${
        props.acpxPushTestError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.acpxPushTestError}</div>`
          : nothing
      }
      ${
        props.acpxPushTestResult
          ? html`<pre class="code-block" style="margin-top: 12px;">${props.acpxPushTestResult}</pre>`
          : nothing
      }
      <div class="list" style="margin-top: 12px;">
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">
              Recent audit history
              <span class="chip">sanitized</span>
              <span class="chip">rate-limit aware</span>
            </div>
            <div class="list-sub">
              ${
                auditHistory
                  ? `${auditHistory.count} push-test audit events · dropped ${auditHistory.dropped} · generated ${auditHistory.generatedAt}`
                  : "Audit history is not loaded yet."
              }
            </div>
          </div>
        </div>
        ${
          auditEvents.length === 0
            ? html`
                <div class="muted">No push-test audit events recorded.</div>
              `
            : auditEvents.map(
                (event) => html`
                  <div class="list-item">
                    <div class="list-main">
                      <div class="list-title">
                        ${event.outcome}
                        <span
                          class="chip ${
                            event.outcome === "succeeded"
                              ? "chip-ok"
                              : event.outcome === "denied"
                                ? "chip-warn"
                                : ""
                          }"
                        >
                          seq ${event.seq}
                        </span>
                      </div>
                      <div class="list-sub">
                        ${formatAcpxAuditDetails(event.details)} · actor ${event.actor} · device
                        ${event.deviceId} · conn ${event.connId}
                      </div>
                    </div>
                    <div class="list-meta mono">${formatAcpxAuditTimestamp(event.ts)}</div>
                  </div>
                `,
              )
        }
      </div>
      <div class="row" style="gap: 8px; flex-wrap: wrap; margin-top: 12px;">
        <button
          class="btn"
          ?disabled=${Boolean(busy) || !props.onAcpxPushTestAction}
          @click=${() => props.onAcpxPushTestAction?.("preview")}
        >
          ${busy === "preview" ? "Previewing..." : "Preview approval"}
        </button>
        <button
          class="btn danger"
          ?disabled=${!canExecute}
          @click=${() => props.onAcpxPushTestAction?.("execute")}
        >
          ${busy === "execute" ? "Executing..." : "Approve and send fixed wrapper"}
        </button>
      </div>
      ${
        pushEnabled
          ? html`
              <div class="callout warn" style="margin-top: 12px">
                Execution still requires the accepted fingerprint, local bridge token/authenticated operator
                connection, rate limit admission, and sanitized audit.
              </div>
            `
          : html`
              <div class="callout" style="margin-top: 12px">
                Enable <span class="mono">fased_push_test_request</span> in ACPX Bridge Config before execution
                can be admitted.
              </div>
            `
      }
    </div>
  `;
}

function renderProviderCatalogCard(status: ModelsCatalogStatusResult | null | undefined) {
  const providers = status?.providers ?? [];
  const topProviders = providers.toSorted((a, b) => b.totalModels - a.totalModels).slice(0, 8);
  const extensionCatalog = status?.providerExtensionCatalog;
  const extensionManifest = status?.providerExtensionManifest;
  const warningEntries = extensionCatalog?.warnings ?? [];
  const deferredProviderIds = extensionManifest?.deferredProviderIds ?? [];
  const missingMappedProviderIds = extensionManifest?.missingMappedProviderIds ?? [];
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Provider Catalog</div>
          <div class="card-sub">
            Model catalog source, configured providers, extension status, and provider-index coverage.
          </div>
        </div>
        <span class="chip ${status ? "chip-ok" : "chip-warn"}">
          ${status ? `${status.availableProviders}/${status.totalProviders} available` : "not loaded"}
        </span>
      </div>
      ${
        status
          ? html`
              <div class="metric-grid" style="margin-top: 12px;">
                <div class="metric">
                  <div class="metric-value">${status.totalModels}</div>
                  <div class="metric-label">models</div>
                </div>
                <div class="metric">
                  <div class="metric-value">${status.configuredProviders}</div>
                  <div class="metric-label">configured</div>
                </div>
                <div class="metric">
                  <div class="metric-value">${status.reasoningModels}</div>
                  <div class="metric-label">reasoning</div>
                </div>
                <div class="metric">
                  <div class="metric-value">${status.visionModels}</div>
                  <div class="metric-label">vision</div>
                </div>
              </div>
              <div class="chip-row" style="margin-top: 12px;">
                <span class="chip">checked ${formatTimestamp(status.checkedAtMs)}</span>
                <span class="chip">model cache ${status.cache.modelCatalog}</span>
                <span class="chip">extension cache ${status.cache.providerExtensionCatalog}</span>
                ${Object.entries(status.sourceCounts).map(
                  ([source, count]) => html`<span class="chip">${source}: ${count}</span>`,
                )}
              </div>
              <div class="list" style="margin-top: 12px;">
                <div class="list-item">
                  <div class="list-main">
                    <div class="list-title">
                      Provider extension catalog
                      <span class="chip ${warningEntries.length === 0 ? "chip-ok" : "chip-warn"}">
                        ${warningEntries.length === 0 ? "clean" : `${warningEntries.length} warning`}
                      </span>
                    </div>
                    <div class="list-sub">
                      ${extensionCatalog?.loadedEntries ?? 0}/${extensionCatalog?.totalEntries ?? 0}
                      loaded · ${extensionCatalog?.modelCount ?? 0} provider-index models ·
                      ${extensionCatalog?.skippedUntrustedEntries ?? 0} skipped untrusted ·
                      ${extensionCatalog?.errorEntries ?? 0} errors · loaded providers:
                      ${formatIdList(extensionCatalog?.loadedProviderIds)}
                    </div>
                  </div>
                </div>
                <div class="list-item">
                  <div class="list-main">
                    <div class="list-title">
                      Provider extension manifest
                      <span class="chip ${deferredProviderIds.length === 0 ? "chip-ok" : "chip-warn"}">
                        ${deferredProviderIds.length === 0 ? "fully mapped" : `${deferredProviderIds.length} deferred`}
                      </span>
                    </div>
                    <div class="list-sub">
                      ${extensionManifest?.mappedProviderCount ?? 0}/${extensionManifest?.upstreamProviderCount ?? 0}
                      upstream providers mapped · missing mapped providers:
                      ${formatIdList(missingMappedProviderIds)} · deferred:
                      ${formatIdList(deferredProviderIds)}
                    </div>
                  </div>
                </div>
                ${warningEntries.slice(0, 4).map(
                  (entry) => html`
                    <div class="list-item">
                      <div class="list-main">
                        <div class="list-title">
                          ${entry.id}
                          <span class="chip chip-warn">${entry.status}</span>
                        </div>
                        <div class="list-sub">
                          ${entry.source} · providers ${formatIdList(entry.providerIds)} ·
                          loaded ${formatIdList(entry.loadedProviderIds)}
                          ${entry.error ? html` · ${entry.error}` : nothing}
                        </div>
                      </div>
                    </div>
                  `,
                )}
              </div>
              <div class="list" style="margin-top: 12px;">
                ${topProviders.map(
                  (provider) => html`
                    <div class="list-item">
                      <div class="list-main">
                        <div class="list-title">
                          ${provider.provider}
                          <span class="chip ${provider.configured ? "chip-ok" : ""}">
                            ${provider.configured ? "configured" : "catalog"}
                          </span>
                        </div>
                        <div class="list-sub">
                          ${provider.totalModels} models · ${provider.reasoningModels} reasoning ·
                          ${provider.visionModels} vision · ${provider.sources.join(", ")}
                        </div>
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
          : html`
              <div class="muted" style="margin-top: 12px">Catalog status is unavailable.</div>
            `
      }
    </section>
  `;
}

function renderAdminRpcControls(props: DebugProps) {
  const disabled = Boolean(props.adminRpcBusy);
  const busyLabel = (action: DebugAdminRpcAction, idle: string) =>
    props.adminRpcBusy === action ? "Working..." : idle;
  return html`
    <div class="card">
      <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
        <div>
          <div class="card-title">Admin RPC Controls</div>
          <div class="card-sub">
            Operator-only side-effecting calls. Every action confirms first, is rate-limited, and writes a sanitized gateway audit event.
          </div>
        </div>
        <span class="chip chip-warn">admin/write</span>
      </div>
      ${
        props.adminRpcError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.adminRpcError}</div>`
          : nothing
      }
      ${
        props.adminRpcResult
          ? html`<pre class="code-block" style="margin-top: 12px;">${props.adminRpcResult}</pre>`
          : nothing
      }
      <div class="surface-split" style="margin-top: 16px;">
        <div class="stack">
          <div class="muted">Chat inject</div>
          <label class="field">
            <span>Session key</span>
            <input
              .value=${props.adminChatSessionKey}
              @input=${(e: Event) =>
                props.onAdminChatSessionKeyChange((e.target as HTMLInputElement).value)}
              placeholder="agent:main:main"
            />
          </label>
          <label class="field">
            <span>Message</span>
            <textarea
              .value=${props.adminChatMessage}
              @input=${(e: Event) =>
                props.onAdminChatMessageChange((e.target as HTMLTextAreaElement).value)}
              rows="3"
            ></textarea>
          </label>
          <button
            class="btn danger"
            ?disabled=${disabled}
            @click=${() => props.onAdminRpcAction("chat.inject")}
          >
            ${busyLabel("chat.inject", "Inject message")}
          </button>
        </div>
        <div class="stack">
          <div class="muted">Push test</div>
          <label class="field">
            <span>Node id</span>
            <input
              .value=${props.adminPushNodeId}
              @input=${(e: Event) =>
                props.onAdminPushNodeIdChange((e.target as HTMLInputElement).value)}
              placeholder="ios-node-1"
            />
          </label>
          <label class="field">
            <span>Title</span>
            <input
              .value=${props.adminPushTitle}
              @input=${(e: Event) =>
                props.onAdminPushTitleChange((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="field">
            <span>Body</span>
            <input
              .value=${props.adminPushBody}
              @input=${(e: Event) =>
                props.onAdminPushBodyChange((e.target as HTMLInputElement).value)}
            />
          </label>
          <button
            class="btn danger"
            ?disabled=${disabled}
            @click=${() => props.onAdminRpcAction("push.test")}
          >
            ${busyLabel("push.test", "Send test push")}
          </button>
        </div>
      </div>
      <div class="stack" style="margin-top: 16px;">
        <div class="muted">Web login</div>
        <label class="field">
          <span>Account id</span>
          <input
            .value=${props.adminWebAccountId}
            @input=${(e: Event) =>
              props.onAdminWebAccountIdChange((e.target as HTMLInputElement).value)}
            placeholder="main"
          />
        </label>
        <div class="row" style="gap: 8px; flex-wrap: wrap;">
          <button
            class="btn danger"
            ?disabled=${disabled}
            @click=${() => props.onAdminRpcAction("web.login.start")}
          >
            ${busyLabel("web.login.start", "Start QR login")}
          </button>
          <button
            class="btn danger"
            ?disabled=${disabled}
            @click=${() => props.onAdminRpcAction("web.login.wait")}
          >
            ${busyLabel("web.login.wait", "Wait for login")}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderCommandCatalogCard(commandsCatalog: CommandsListResult | null | undefined) {
  const commands = commandsCatalog?.commands ?? [];
  const sourceCounts = countCommandsBySource(commandsCatalog);
  const topCommands = commands.slice(0, 10);
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Command Catalog</div>
          <div class="card-sub">Gateway-visible command names, sources, and scopes.</div>
        </div>
        <span class="chip ${commandsCatalog ? "chip-ok" : "chip-warn"}">
          ${commandsCatalog ? `${commands.length} commands` : "not loaded"}
        </span>
      </div>
      ${
        commandsCatalog
          ? html`
              <div class="chip-row" style="margin-top: 12px;">
                ${sourceCounts.map(([source, count]) => html`<span class="chip">${source}: ${count}</span>`)}
              </div>
              <div class="list" style="margin-top: 12px;">
                ${topCommands.map(
                  (command) => html`
                    <div class="list-item">
                      <div class="list-main">
                        <div class="list-title">
                          ${command.name}
                          <span class="chip">${command.source}</span>
                          <span class="chip">${command.scope}</span>
                        </div>
                        <div class="list-sub">${command.description}</div>
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
          : html`
              <div class="muted" style="margin-top: 12px">Command list is unavailable.</div>
            `
      }
    </section>
  `;
}

function renderPluginMarketplaceCard(report: PluginsMarketplaceListResult | null | undefined) {
  const plugins = report?.plugins ?? [];
  const loaded = plugins.filter((entry) => entry.loaded).length;
  const errors = plugins.filter((entry) => entry.status === "error").length;
  const restartPending = plugins.filter(
    (entry) => entry.managed && entry.enabled && !entry.loaded,
  ).length;
  const updateable = plugins.filter((entry) => entry.actions.includes("update")).length;
  const topAttention = plugins
    .filter(
      (entry) =>
        entry.status === "error" ||
        (entry.managed && entry.enabled && !entry.loaded) ||
        entry.actions.includes("update"),
    )
    .slice(0, 8);

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Plugin Runtime Status</div>
          <div class="card-sub">Marketplace, install, update, and runtime-state summary.</div>
        </div>
        <span class="chip ${report ? "chip-ok" : "chip-warn"}">
          ${report ? `${plugins.length} plugins` : "not loaded"}
        </span>
      </div>
      ${
        report
          ? html`
              <div class="chip-row" style="margin-top: 12px;">
                <span class="chip">loaded ${loaded}</span>
                <span class="chip ${errors > 0 ? "chip-warn" : ""}">errors ${errors}</span>
                <span class="chip ${restartPending > 0 ? "chip-warn" : ""}">
                  restart pending ${restartPending}
                </span>
                <span class="chip">updates ${updateable}</span>
                <span class="chip">diagnostics ${report.diagnostics.length}</span>
              </div>
              <div class="list" style="margin-top: 12px;">
                ${
                  topAttention.length === 0
                    ? html`
                        <div class="muted">No plugin runtime attention items.</div>
                      `
                    : topAttention.map(
                        (entry) => html`
                          <div class="list-item">
                            <div class="list-main">
                              <div class="list-title">
                                ${entry.name}
                                <span class="chip">${entry.status}</span>
                                ${
                                  entry.actions.includes("update")
                                    ? html`
                                        <span class="chip">update</span>
                                      `
                                    : nothing
                                }
                              </div>
                              <div class="list-sub">
                                ${entry.id}
                                ${
                                  entry.managed && entry.enabled && !entry.loaded
                                    ? " · runtime reload pending"
                                    : ""
                                }
                                ${entry.error ? ` · ${entry.error}` : ""}
                              </div>
                            </div>
                          </div>
                        `,
                      )
                }
              </div>
            `
          : html`
              <div class="muted" style="margin-top: 12px">Plugin marketplace status is unavailable.</div>
            `
      }
    </section>
  `;
}

function renderGatewayStartupCard(status: Record<string, unknown> | null) {
  const startup = readGatewayStartup(status);
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Gateway Startup</div>
          <div class="card-sub">Latest gateway startup phase timings from the active process.</div>
        </div>
        <span class="chip ${startup ? "chip-ok" : "chip-warn"}">
          ${startup ? formatDuration(startup.totalMs) : "not recorded"}
        </span>
      </div>
      ${
        startup
          ? html`
              <div class="muted" style="margin-top: 12px;">
                ${
                  startup.recordedAtMs > 0
                    ? new Date(startup.recordedAtMs).toLocaleString()
                    : "Recorded during startup."
                }
              </div>
              <div class="list" style="margin-top: 12px;">
                ${startup.entries.map(
                  (entry) => html`
                    <div class="list-item">
                      <div class="list-main">
                        <div class="list-title">${entry.name}</div>
                      </div>
                      <div class="list-meta mono">${formatDuration(entry.durationMs)}</div>
                    </div>
                  `,
                )}
              </div>
              <pre class="code-block" style="margin-top: 12px;">${startup.summary}</pre>
            `
          : html`
              <div class="muted" style="margin-top: 12px">
                Restart the gateway with current code to capture startup timings.
              </div>
            `
      }
    </section>
  `;
}

function renderStrictAgenticPolicyCard(status: Record<string, unknown> | null) {
  const policy = readStrictAgenticStatus(status);
  const visibleAgents = policy?.agents.slice(0, 8) ?? [];
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Strict-Agentic Policy</div>
          <div class="card-sub">
            Warning-only diagnostics for planned-without-action or empty agent runs.
          </div>
        </div>
        <span class="chip ${policy?.mode === "warn" ? "chip-warn" : policy ? "chip-ok" : ""}">
          ${
            policy
              ? policy.mode === "warn"
                ? `${policy.warningAgents}/${policy.totalAgents} warn`
                : "off"
              : "not loaded"
          }
        </span>
      </div>
      ${
        policy
          ? html`
              <div class="row" style="margin-top: 12px;">
                <span class="chip">source ${policy.source}</span>
                <span class="chip">${policy.envFlagSet ? "env fallback set" : "env fallback clear"}</span>
                <span class="chip ${policy.enforcementAvailable ? "chip-warn" : ""}">
                  ${policy.enforcementAvailable ? "enforcement available" : "enforcement disabled"}
                </span>
              </div>
              <div class="list" style="margin-top: 12px;">
                ${
                  visibleAgents.length > 0
                    ? visibleAgents.map(
                        (agent) => html`
                          <div class="list-item">
                            <div class="list-main">
                              <div class="list-title">${agent.agentId}</div>
                              <div class="list-sub">
                                source ${agent.source}${agent.override ? " · per-agent override" : ""}
                              </div>
                            </div>
                            <div class="list-meta">
                              <span class="chip ${agent.mode === "warn" ? "chip-warn" : "chip-ok"}">
                                ${agent.mode}
                              </span>
                            </div>
                          </div>
                        `,
                      )
                    : html`
                        <div class="muted">No agents are included in the status summary.</div>
                      `
                }
              </div>
            `
          : html`
              <div class="muted" style="margin-top: 12px">Strict-agentic policy status is unavailable.</div>
            `
      }
    </section>
  `;
}

function formatDiagnosticTimestamp(ts: number | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
    return "unknown";
  }
  return new Date(ts).toLocaleTimeString();
}

function readConfigValue(
  config: Record<string, unknown> | null | undefined,
  path: Array<string | number>,
) {
  let cursor: unknown = config;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[String(segment)];
  }
  return cursor;
}

function readConfigBoolean(
  config: Record<string, unknown> | null | undefined,
  path: Array<string | number>,
  fallback = false,
): boolean {
  const value = readConfigValue(config, path);
  return typeof value === "boolean" ? value : fallback;
}

function readConfigString(
  config: Record<string, unknown> | null | undefined,
  path: Array<string | number>,
  fallback = "",
): string {
  const value = readConfigValue(config, path);
  return typeof value === "string" ? value : fallback;
}

function readConfigStringArray(
  config: Record<string, unknown> | null | undefined,
  path: Array<string | number>,
): string[] {
  const value = readConfigValue(config, path);
  return Array.isArray(value)
    ? value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean)
    : [];
}

function formatDiagnosticEventMeta(event: DiagnosticStabilitySnapshot["events"][number]): string {
  const parts = [
    event.channel ? `channel ${event.channel}` : null,
    event.source ? `source ${event.source}` : null,
    event.outcome ? `outcome ${event.outcome}` : null,
    event.reason ? `reason ${event.reason}` : null,
    event.provider ? `provider ${event.provider}` : null,
    event.model ? `model ${event.model}` : null,
    event.toolName ? `tool ${event.toolName}` : null,
    event.queueDepth !== undefined ? `queue ${event.queueDepth}` : null,
    event.waitMs !== undefined ? `wait ${formatDuration(event.waitMs)}` : null,
    event.durationMs !== undefined ? `duration ${formatDuration(event.durationMs)}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "sanitized event payload";
}

function renderDiagnosticsConfigCard(props: DebugProps) {
  const config = props.configForm ?? null;
  const canEdit = Boolean(config && props.onConfigPatch);
  const disabled = !canEdit || props.configSaving === true;
  const diagnosticsEnabled = readConfigBoolean(config, ["diagnostics", "enabled"], false);
  const flags = readConfigStringArray(config, ["diagnostics", "flags"]);
  const otelEnabled = readConfigBoolean(config, ["diagnostics", "otel", "enabled"], false);
  const otelEndpoint = readConfigString(config, ["diagnostics", "otel", "endpoint"], "");
  const otelProtocol = readConfigString(
    config,
    ["diagnostics", "otel", "protocol"],
    "http/protobuf",
  );
  const prometheusEnabled = readConfigBoolean(
    config,
    ["diagnostics", "prometheus", "enabled"],
    false,
  );
  const prometheusPath = readConfigString(
    config,
    ["diagnostics", "prometheus", "path"],
    "/metrics",
  );
  const prometheusRequireAuth = readConfigBoolean(
    config,
    ["diagnostics", "prometheus", "requireAuth"],
    true,
  );
  const prometheusIncludeRuntime = readConfigBoolean(
    config,
    ["diagnostics", "prometheus", "includeRuntime"],
    true,
  );
  const cacheTraceEnabled = readConfigBoolean(
    config,
    ["diagnostics", "cacheTrace", "enabled"],
    false,
  );
  const cacheTraceMessages = readConfigBoolean(
    config,
    ["diagnostics", "cacheTrace", "includeMessages"],
    false,
  );

  const renderToggle = (params: {
    label: string;
    checked: boolean;
    path: Array<string | number>;
  }) => html`
    <label class="debug-toggle">
      <span class="debug-toggle__label">${params.label}</span>
      <input
        type="checkbox"
        .checked=${params.checked}
        ?disabled=${disabled}
        @change=${(event: Event) =>
          props.onConfigPatch?.(params.path, (event.target as HTMLInputElement).checked)}
      />
      <span class="debug-toggle__track" aria-hidden="true">
        <span class="debug-toggle__thumb"></span>
      </span>
    </label>
  `;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <div class="card-title">Diagnostics Controls</div>
          <div class="card-sub">Enable temporary observability without opening raw config.</div>
        </div>
        <div class="row" style="gap: 8px;">
          <button class="btn btn--sm" ?disabled=${props.configSaving} @click=${() => props.onConfigReload?.()}>
            Reload
          </button>
          <button
            class="btn btn--sm primary"
            ?disabled=${props.configSaving || !props.configDirty || !props.onConfigSave}
            @click=${() => props.onConfigSave?.()}
          >
            ${props.configSaving ? "Saving..." : "Save diagnostics"}
          </button>
        </div>
      </div>
      <div class="metric-grid" style="margin-top: 12px;">
        <div class="metric">
          <div class="metric-value">${diagnosticsEnabled ? "on" : "off"}</div>
          <div class="metric-label">diagnostics</div>
        </div>
        <div class="metric">
          <div class="metric-value">${flags.length}</div>
          <div class="metric-label">flags</div>
        </div>
        <div class="metric">
          <div class="metric-value">${otelEnabled ? "on" : "off"}</div>
          <div class="metric-label">otel</div>
        </div>
        <div class="metric">
          <div class="metric-value">${prometheusEnabled ? "on" : "off"}</div>
          <div class="metric-label">prometheus</div>
        </div>
        <div class="metric">
          <div class="metric-value">${cacheTraceEnabled ? "on" : "off"}</div>
          <div class="metric-label">cache trace</div>
        </div>
      </div>
      <div class="filters" style="margin-top: 14px;">
        ${renderToggle({
          label: "Diagnostics",
          checked: diagnosticsEnabled,
          path: ["diagnostics", "enabled"],
        })}
        <label class="field" style="min-width: 260px;">
          <span>Flags</span>
          <input
            .value=${flags.join(", ")}
            ?disabled=${disabled}
            placeholder="telegram.http, task.*"
            @input=${(event: Event) =>
              props.onConfigPatch?.(
                ["diagnostics", "flags"],
                (event.target as HTMLInputElement).value
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter(Boolean),
              )}
          />
        </label>
        ${renderToggle({
          label: "OpenTelemetry",
          checked: otelEnabled,
          path: ["diagnostics", "otel", "enabled"],
        })}
        <label class="field" style="min-width: 260px;">
          <span>OTEL endpoint</span>
          <input
            .value=${otelEndpoint}
            ?disabled=${disabled}
            placeholder="https://collector.example/v1/traces"
            @input=${(event: Event) =>
              props.onConfigPatch?.(
                ["diagnostics", "otel", "endpoint"],
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>
        <label class="field">
          <span>OTEL protocol</span>
          <select
            .value=${otelProtocol}
            ?disabled=${disabled}
            @change=${(event: Event) =>
              props.onConfigPatch?.(
                ["diagnostics", "otel", "protocol"],
                (event.target as HTMLSelectElement).value,
              )}
          >
            ${["http/protobuf", "grpc"].map(
              (option) =>
                html`<option value=${option} ?selected=${option === otelProtocol}>${option}</option>`,
            )}
          </select>
        </label>
        ${renderToggle({
          label: "Prometheus",
          checked: prometheusEnabled,
          path: ["diagnostics", "prometheus", "enabled"],
        })}
        <label class="field">
          <span>Metrics path</span>
          <input
            .value=${prometheusPath}
            ?disabled=${disabled}
            placeholder="/metrics"
            @input=${(event: Event) =>
              props.onConfigPatch?.(
                ["diagnostics", "prometheus", "path"],
                (event.target as HTMLInputElement).value || "/metrics",
              )}
          />
        </label>
        ${renderToggle({
          label: "Metrics auth",
          checked: prometheusRequireAuth,
          path: ["diagnostics", "prometheus", "requireAuth"],
        })}
        ${renderToggle({
          label: "Runtime gauges",
          checked: prometheusIncludeRuntime,
          path: ["diagnostics", "prometheus", "includeRuntime"],
        })}
        ${renderToggle({
          label: "Cache trace",
          checked: cacheTraceEnabled,
          path: ["diagnostics", "cacheTrace", "enabled"],
        })}
        ${renderToggle({
          label: "Trace messages",
          checked: cacheTraceMessages,
          path: ["diagnostics", "cacheTrace", "includeMessages"],
        })}
      </div>
      <div class="muted" style="margin-top: 10px;">
        Keep verbose diagnostics temporary. Cache trace and OTEL can include operational context.
      </div>
    </section>
  `;
}

function renderDiagnosticsStabilityCard(snapshot: DiagnosticStabilitySnapshot | null | undefined) {
  const events = snapshot?.events ?? [];
  const latestEvents = events.toReversed().slice(0, 8);
  const typeCounts = Object.entries(snapshot?.summary.byType ?? {})
    .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 10);
  const sessionSummary = snapshot?.summary.sessions;
  const webhookSummary = snapshot?.summary.webhooks;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Diagnostic Stability</div>
          <div class="card-sub">Sanitized runtime stability events captured by the gateway.</div>
        </div>
        <span class="chip ${snapshot ? "chip-ok" : "chip-warn"}">
          ${snapshot ? `${snapshot.count} events` : "not loaded"}
        </span>
      </div>
      ${
        snapshot
          ? html`
              <div class="metric-grid" style="margin-top: 12px;">
                <div class="metric">
                  <div class="metric-value">${snapshot.count}</div>
                  <div class="metric-label">matching events</div>
                </div>
                <div class="metric">
                  <div class="metric-value">${snapshot.capacity}</div>
                  <div class="metric-label">capacity</div>
                </div>
                <div class="metric">
                  <div class="metric-value">${snapshot.dropped}</div>
                  <div class="metric-label">dropped</div>
                </div>
                <div class="metric">
                  <div class="metric-value">${snapshot.lastSeq ?? "n/a"}</div>
                  <div class="metric-label">last seq</div>
                </div>
              </div>
              <div class="chip-row" style="margin-top: 12px;">
                ${
                  typeCounts.length > 0
                    ? typeCounts.map(
                        ([type, count]) => html`<span class="chip">${type}: ${count}</span>`,
                      )
                    : html`
                        <span class="chip">no event types</span>
                      `
                }
                ${
                  sessionSummary
                    ? html`
                        <span class="chip ${sessionSummary.stuck > 0 ? "chip-warn" : ""}">
                          stuck sessions ${sessionSummary.stuck}
                        </span>
                        <span class="chip">max queue ${sessionSummary.maxQueueDepth ?? 0}</span>
                      `
                    : nothing
                }
                ${
                  webhookSummary
                    ? html`
                        <span class="chip">webhook received ${webhookSummary.received}</span>
                        <span class="chip ${webhookSummary.errors > 0 ? "chip-warn" : ""}">
                          webhook errors ${webhookSummary.errors}
                        </span>
                      `
                    : nothing
                }
              </div>
              <div class="list" style="margin-top: 12px;">
                ${
                  latestEvents.length === 0
                    ? html`
                        <div class="muted">No diagnostic stability events recorded.</div>
                      `
                    : latestEvents.map(
                        (event) => html`
                          <div class="list-item">
                            <div class="list-main">
                              <div class="list-title">
                                ${event.type}
                                <span class="chip">seq ${event.seq}</span>
                              </div>
                              <div class="list-sub">${formatDiagnosticEventMeta(event)}</div>
                            </div>
                            <div class="list-meta mono">${formatDiagnosticTimestamp(event.ts)}</div>
                          </div>
                        `,
                      )
                }
              </div>
            `
          : html`
              <div class="muted" style="margin-top: 12px">
                Diagnostics stability is available when gateway diagnostics are enabled.
              </div>
            `
      }
    </section>
  `;
}

function formatMemoryPathLabel(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "none";
  }
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return `[path:${parts.at(-1) ?? "root"}]`;
}

function renderMemoryDoctorRepairPreviewCard(props: {
  inventory?: DoctorMemoryInventoryPayload | null;
  validation?: DoctorMemoryValidationPayload | null;
  preview?: DoctorMemoryRepairPreviewPayload | null;
  adminRpcBusy?: string | null;
  onAdminRpcAction: (action: DebugAdminRpcAction) => void;
}) {
  const inventory = props.inventory ?? null;
  const validation = props.validation ?? null;
  const preview = props.preview ?? null;
  const loaded = Boolean(inventory || validation || preview);
  const proposals = preview?.proposals ?? [];
  const supported = proposals.filter((proposal) => proposal.supported);
  const blocked = proposals.filter((proposal) => !proposal.supported);
  const topProposals = [...supported, ...blocked].slice(0, 8);
  const tone =
    (validation?.summary.errors ?? 0) > 0 || (preview?.summary.blocked ?? 0) > 0
      ? "chip-warn"
      : loaded
        ? "chip-ok"
        : "chip-warn";

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Memory Repair Preview</div>
          <div class="card-sub">
            Memory doctor inventory, validation, dry-run repair proposals, and gated execution.
          </div>
        </div>
        <span class="chip ${tone}">
          ${preview ? `${preview.summary.proposals} proposals` : loaded ? "loaded" : "not loaded"}
        </span>
      </div>
      ${
        loaded
          ? html`
              <div class="chip-row" style="margin-top: 12px;">
                <span class="chip">diagnostic</span>
                <span class="chip">dry-run</span>
                <span class="chip">gated writes</span>
                <span class="chip">explicit confirmation</span>
                <span class="chip">
                  agent ${preview?.agentId ?? validation?.agentId ?? inventory?.agentId ?? "unknown"}
                </span>
                ${
                  inventory
                    ? html`
                        <span class="chip">
                          workspace ${inventory.workspace.exists ? "present" : "missing"}
                        </span>
                      `
                    : nothing
                }
                ${
                  validation
                    ? html`
                        <span class="chip ${validation.summary.errors > 0 ? "chip-warn" : ""}">
                          ${validation.summary.errors} errors
                        </span>
                        <span class="chip ${validation.summary.warnings > 0 ? "chip-warn" : ""}">
                          ${validation.summary.warnings} warnings
                        </span>
                      `
                    : nothing
                }
                ${
                  preview
                    ? html`
                        <span class="chip">${preview.summary.supported} supported</span>
                        <span class="chip ${preview.summary.blocked > 0 ? "chip-warn" : ""}">
                          ${preview.summary.blocked} blocked
                        </span>
                      `
                    : nothing
                }
              </div>
              <div class="callout warn" style="margin-top: 12px;">
                Repair execution is write-capable and operator-only. It records backup, audit, and
                rollback metadata before applying supported proposals.
              </div>
              <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap;">
                <button
                  class="btn danger"
                  ?disabled=${supported.length === 0 || props.adminRpcBusy === "doctor.memory.repair.execute"}
                  @click=${() => props.onAdminRpcAction("doctor.memory.repair.execute")}
                >
                  ${
                    props.adminRpcBusy === "doctor.memory.repair.execute"
                      ? "Executing repair..."
                      : `Execute ${supported.length} supported repairs`
                  }
                </button>
                <span class="chip">operator.admin</span>
                <span class="chip">backup + audit required</span>
              </div>
              <div class="list" style="margin-top: 12px;">
                ${
                  topProposals.length === 0
                    ? html`
                        <div class="muted">No dry-run repair proposals are currently reported.</div>
                      `
                    : topProposals.map(
                        (proposal) => html`
                          <div class="list-item">
                            <div class="list-main">
                              <div class="list-title">
                                ${proposal.action}
                                <span class="chip ${proposal.supported ? "chip-ok" : "chip-warn"}">
                                  ${proposal.supported ? "supported dry-run" : "blocked"}
                                </span>
                                <span class="chip">${proposal.severity}</span>
                              </div>
                              <div class="list-sub">
                                ${proposal.description}
                                ${
                                  proposal.targetPath
                                    ? ` · ${formatMemoryPathLabel(proposal.targetPath)}`
                                    : ""
                                }
                                ${proposal.blockReason ? ` · ${proposal.blockReason}` : ""}
                              </div>
                            </div>
                            <div class="list-meta mono">${proposal.id}</div>
                          </div>
                        `,
                      )
                }
              </div>
            `
          : html`
              <div class="muted" style="margin-top: 12px">Memory doctor diagnostics are not loaded yet.</div>
            `
      }
    </section>
  `;
}

function renderDebugSurfaceMap(props: DebugProps) {
  const startup = readGatewayStartup(props.status);
  const strictAgentic = readStrictAgenticStatus(props.status);
  const acpxBridge = readAcpxBridgeStatus(props.status);
  const readOnlyLoaded = [
    props.modelCatalogStatus,
    props.commandsCatalog,
    props.pluginsMarketplace,
    props.taskLedger,
    props.diagnosticsStability,
    props.memoryInventory ?? props.memoryValidation ?? props.memoryRepairPreview,
    startup,
    strictAgentic,
  ].filter(Boolean).length;
  const mutatingWrapperState = acpxBridge.fasedPushTestRequest.enabled
    ? "operator-approved"
    : "disabled";
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
        <div>
          <div class="card-title">Debug Surface Map</div>
          <div class="card-sub">
            Operator diagnostics and guarded controls grouped by risk. Use specific cards before
            falling back to raw RPC.
          </div>
        </div>
        <span class="chip">${readOnlyLoaded} status feeds loaded</span>
      </div>
      <div class="chip-row" style="margin-top: 12px;">
        <span class="chip chip-ok">read-only status</span>
        <span class="chip chip-warn">admin/write audited</span>
        <span class="chip">ACPX fixed wrappers only</span>
        <span class="chip">manual RPC expert</span>
      </div>
      <div class="list" style="margin-top: 12px;">
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">Read-only diagnostics</div>
            <div class="list-sub">
              Provider catalog, command catalog, plugin runtime, gateway startup,
              strict-agentic policy, diagnostics stability, and Memory Doctor preview.
            </div>
          </div>
        </div>
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">Guarded admin/write controls</div>
            <div class="list-sub">
              chat.inject, push.test, web login, Memory Doctor repair execute, and ACPX
              fased_push_test_request all require operator/admin flow, audit, and rate limits.
            </div>
          </div>
        </div>
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">Not generic exposure</div>
            <div class="list-sub">
              Generic mutating MCP/ACPX tools and blanket plugin access to admin RPCs remain closed.
              Current ACPX mutating wrapper state: ${mutatingWrapperState}.
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

type DebugSectionTone = "ok" | "warn" | "danger" | "neutral";

type DebugSection = {
  id: string;
  title: string;
  detail: string;
  status: string;
  tone: DebugSectionTone;
  priority: number;
  open?: boolean;
  content: unknown;
};

function debugToneClass(tone: DebugSectionTone): string {
  if (tone === "ok") {
    return "ok";
  }
  if (tone === "warn") {
    return "warn";
  }
  if (tone === "danger") {
    return "danger";
  }
  return "";
}

function renderDebugStyles() {
  return html`
    <style>
      .debug-page {
        display: grid;
        gap: 12px;
      }

      .debug-toolbar {
        display: flex;
        justify-content: flex-end;
      }

      .debug-section-list {
        display: grid;
        gap: 10px;
      }

      .debug-section {
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--panel);
        overflow: visible;
      }

      .debug-section[open] {
        border-color: var(--border-strong, var(--border));
      }

      .debug-section__summary {
        align-items: center;
        cursor: pointer;
        display: grid;
        gap: 12px;
        grid-template-columns: minmax(0, 1fr) auto;
        list-style: none;
        padding: 12px 14px;
      }

      .debug-section__summary:hover {
        background: var(--bg-hover);
      }

      .debug-section__summary::-webkit-details-marker {
        display: none;
      }

      .debug-section__main {
        align-items: center;
        display: flex;
        gap: 10px;
        min-width: 0;
      }

      .debug-section__dot {
        border-radius: 999px;
        background: var(--muted);
        flex: 0 0 auto;
        height: 8px;
        width: 8px;
      }

      .debug-section__dot.ok {
        background: var(--success);
      }

      .debug-section__dot.warn {
        background: var(--warning);
      }

      .debug-section__dot.danger {
        background: var(--danger);
      }

      .debug-section__title {
        color: var(--text-strong);
        font-size: 14px;
        font-weight: 820;
        line-height: 1.2;
      }

      .debug-section__detail {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
        margin-top: 2px;
      }

      .debug-section__meta {
        align-items: center;
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }

      .debug-section__status {
        border: 1px solid var(--border);
        border-radius: 999px;
        color: var(--muted);
        font-size: 11px;
        font-weight: 750;
        line-height: 1;
        padding: 5px 8px;
        white-space: nowrap;
      }

      .debug-section__status.ok {
        border-color: color-mix(in srgb, var(--success) 36%, var(--border));
        color: var(--success);
      }

      .debug-section__status.warn {
        border-color: color-mix(in srgb, var(--warning) 40%, var(--border));
        color: var(--warning);
      }

      .debug-section__status.danger {
        border-color: color-mix(in srgb, var(--danger) 40%, var(--border));
        color: var(--danger);
      }

      .debug-section__chevron {
        color: var(--muted);
        font-size: 12px;
        font-weight: 800;
      }

      .debug-section[open] .debug-section__chevron {
        transform: rotate(180deg);
      }

      .debug-section__body {
        border-top: 1px solid var(--border);
        display: grid;
        gap: 14px;
        padding: 14px 16px 16px;
      }

      .debug-section__body > .card {
        border: 0;
        border-radius: 0;
        background: transparent;
        box-shadow: none;
        padding: 0;
      }

      .debug-section__body > .card > .card-title,
      .debug-section__body > .card > .card-sub,
      .debug-section__body > .card > .row:first-child .card-title,
      .debug-section__body > .card > .row:first-child .card-sub,
      .debug-section__body > section.card > .card-title,
      .debug-section__body > section.card > .card-sub,
      .debug-section__body > section.card > .row:first-child .card-title,
      .debug-section__body > section.card > .row:first-child .card-sub {
        display: none;
      }

      .debug-section__body > section.card {
        border: 0;
        border-radius: 0;
        background: transparent;
        box-shadow: none;
        padding: 0;
      }

      .debug-toggle {
        align-items: center;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--text-muted);
        display: inline-flex;
        gap: 10px;
        min-height: 38px;
        padding: 8px 10px;
      }

      .debug-toggle input {
        height: 1px;
        opacity: 0;
        position: absolute;
        width: 1px;
      }

      .debug-toggle__label {
        font-size: 12px;
        font-weight: 720;
        white-space: nowrap;
      }

      .debug-toggle__track {
        align-items: center;
        background: var(--secondary);
        border: 1px solid var(--border);
        border-radius: 999px;
        display: inline-flex;
        flex: 0 0 auto;
        height: 20px;
        padding: 2px;
        width: 38px;
      }

      .debug-toggle__thumb {
        background: var(--muted);
        border-radius: 999px;
        display: block;
        height: 14px;
        transform: translateX(0);
        transition:
          background var(--duration-fast) ease,
          transform var(--duration-fast) ease;
        width: 14px;
      }

      .debug-toggle input:checked + .debug-toggle__track .debug-toggle__thumb {
        background: var(--text-strong);
        transform: translateX(18px);
      }

      .debug-toggle input:disabled + .debug-toggle__track {
        opacity: 0.55;
      }

      @media (max-width: 720px) {
        .debug-section__summary {
          grid-template-columns: 1fr;
        }

        .debug-section__meta {
          justify-content: flex-start;
        }
      }
    </style>
  `;
}

function renderDebugSection(section: DebugSection) {
  return html`
    <details class="debug-section" data-debug-section=${section.id}>
      <summary class="debug-section__summary">
        <div class="debug-section__main">
          <span class="debug-section__dot ${debugToneClass(section.tone)}"></span>
          <div>
            <div class="debug-section__title">${section.title}</div>
            <div class="debug-section__detail">${section.detail}</div>
          </div>
        </div>
        <div class="debug-section__meta">
          <span class="debug-section__status ${debugToneClass(section.tone)}">${section.status}</span>
          <span class="debug-section__chevron" aria-hidden="true">v</span>
        </div>
      </summary>
      <div class="debug-section__body">${section.content}</div>
    </details>
  `;
}

function renderSnapshotsCard(
  props: DebugProps,
  params: { securityTone: string; securityLabel: string; info: number },
) {
  return html`
    <div class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Snapshots</div>
          <div class="card-sub">Status, health, and heartbeat data.</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("common.refreshing") : t("common.refresh")}
        </button>
      </div>
      <div class="stack" style="margin-top: 12px;">
        <div>
          <div class="muted">Status</div>
          ${
            params.securityLabel
              ? html`<div class="callout ${params.securityTone}" style="margin-top: 8px;">
                  Security audit: ${params.securityLabel}${params.info > 0 ? ` · ${params.info} info` : ""}. Run
                  <span class="mono">fased security audit --deep</span> for details.
                </div>`
              : nothing
          }
          <pre class="code-block">${JSON.stringify(props.status ?? {}, null, 2)}</pre>
        </div>
        <div>
          <div class="muted">Health</div>
          <pre class="code-block">${JSON.stringify(props.health ?? {}, null, 2)}</pre>
        </div>
        <div>
          <div class="muted">Last heartbeat</div>
          <pre class="code-block">${JSON.stringify(props.heartbeat ?? {}, null, 2)}</pre>
        </div>
      </div>
    </div>
  `;
}

type TaskAuditCategory = {
  id: string;
  title: string;
  description: string;
  codes: string[];
};

const TASK_AUDIT_CATEGORIES: TaskAuditCategory[] = [
  {
    id: "stale",
    title: "Stale running work",
    description: "Queued or running task/flow records that are older than the maintenance window.",
    codes: ["stale-running-task", "stale-workflow-run"],
  },
  {
    id: "delivery",
    title: "Delivery state",
    description: "Terminal work with unresolved delivery or conflicting delivery metadata.",
    codes: ["missing-delivery-state", "delivery-state-conflict"],
  },
  {
    id: "cron",
    title: "Cron reconciliation",
    description: "Scheduled task records that no longer match the cron queue.",
    codes: ["orphaned-cron-run", "orphaned-cron-task"],
  },
  {
    id: "workflow",
    title: "Workflow definitions",
    description: "Saved step/graph workflows that cannot be loaded safely.",
    codes: [
      "broken-workflow-definition-store",
      "broken-workflow-definition",
      "broken-workflow-graph",
      "broken-workflow-graph-start",
      "broken-workflow-graph-edge",
    ],
  },
  {
    id: "ledger",
    title: "Ledger integrity",
    description: "Duplicate or inconsistent task identifiers across sources.",
    codes: ["duplicate-run-id"],
  },
];

function taskAuditCategoryFindings(
  findings: TaskAuditFinding[],
  category: TaskAuditCategory,
): TaskAuditFinding[] {
  const codes = new Set(category.codes);
  return findings.filter((finding) => codes.has(finding.code));
}

function taskAuditUncategorizedFindings(findings: TaskAuditFinding[]): TaskAuditFinding[] {
  const knownCodes = new Set(TASK_AUDIT_CATEGORIES.flatMap((category) => category.codes));
  return findings.filter((finding) => !knownCodes.has(finding.code));
}

function renderTaskAuditFinding(finding: TaskAuditFinding) {
  return html`
    <div class=${`callout ${finding.severity === "error" ? "danger" : finding.severity === "warn" ? "warn" : "info"}`}>
      <div>${finding.message}</div>
      <div class="muted mono" style="margin-top: 4px;">
        ${[finding.code, finding.source, finding.runId ?? finding.taskId].filter(Boolean).join(" · ")}
      </div>
    </div>
  `;
}

function renderTaskLedgerDiagnosticsCard(props: DebugProps) {
  const taskLedger = props.taskLedger;
  const findings = taskLedger?.audit?.findings ?? [];
  const warnings = findings.filter((finding) => finding.severity !== "info");
  const uncategorized = taskAuditUncategorizedFindings(findings);
  return html`
    <div class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Task Audit</div>
          <div class="card-sub">Detached work integrity, stale running checks, cron reconciliation, and workflow graph validation.</div>
        </div>
        <div class="row" style="gap: 8px;">
          <span class="chip">${taskLedger?.summary.total ?? 0} records</span>
          <button
            class="btn btn--sm"
            ?disabled=${props.taskLedgerBusy || !props.onTaskLedgerMaintenance}
            title="Mark queued/running task and workflow records older than the default maintenance window as lost."
            @click=${() => props.onTaskLedgerMaintenance?.()}
          >
            ${props.taskLedgerBusy ? "Running..." : "Mark stale lost"}
          </button>
          <button
            class="btn btn--sm"
            ?disabled=${props.taskLedgerBusy || !props.onTaskLedgerMaintenance}
            title="Use a tighter 30 minute window for clearly stuck task and workflow records."
            @click=${() => props.onTaskLedgerMaintenance?.({ staleRunningMs: 30 * 60_000 })}
          >
            Mark stuck 30m
          </button>
          <button
            class="btn btn--sm"
            ?disabled=${props.taskLedgerBusy || !props.onTaskLedgerMaintenance}
            title="Remove cron queue rows whose scheduled task definition was deleted. Normal Agent Tasks already hides these rows."
            @click=${() => props.onTaskLedgerMaintenance?.({ cleanupOrphanedCronRuns: true })}
          >
            Clean stale cron history
          </button>
        </div>
      </div>
      <div class="metrics-grid" style="margin-top: 12px;">
        <div class="metric-card">
          <div class="metric-value">${taskLedger?.summary.running ?? 0}</div>
          <div class="metric-label">running</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${taskLedger?.summary.queued ?? 0}</div>
          <div class="metric-label">queued</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${taskLedger?.summary.failed ?? 0}</div>
          <div class="metric-label">failed</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${taskLedger?.summary.lost ?? 0}</div>
          <div class="metric-label">lost</div>
        </div>
      </div>
      ${
        props.taskLedgerError
          ? html`
              <div class="callout danger" style="margin-top: 12px;">${props.taskLedgerError}</div>
            `
          : nothing
      }
      ${
        props.taskLedgerMaintenanceMessage
          ? html`
              <div class="callout success" style="margin-top: 12px;">
                ${props.taskLedgerMaintenanceMessage}
              </div>
            `
          : nothing
      }
      <div class="metrics-grid" style="margin-top: 12px;">
        ${TASK_AUDIT_CATEGORIES.map((category) => {
          const categoryFindings = taskAuditCategoryFindings(warnings, category);
          return html`
            <div class="metric-card">
              <div class="metric-value">${categoryFindings.length}</div>
              <div class="metric-label">${category.title}</div>
              <div class="muted" style="font-size: 11px; margin-top: 4px;">
                ${category.description}
              </div>
            </div>
          `;
        })}
      </div>
      <div class="stack" style="margin-top: 12px;">
        ${
          !taskLedger
            ? html`
                <div class="muted">Run history audit has not loaded yet.</div>
              `
            : warnings.length === 0
              ? html`
                  <div class="callout success">No task-ledger warnings are visible.</div>
                `
              : html`
                  ${TASK_AUDIT_CATEGORIES.map((category) => {
                    const categoryFindings = taskAuditCategoryFindings(warnings, category);
                    if (categoryFindings.length === 0) {
                      return nothing;
                    }
                    return html`
                      <div class="stack">
                        <div class="card-title">${category.title}</div>
                        ${categoryFindings.map((finding) => renderTaskAuditFinding(finding))}
                      </div>
                    `;
                  })}
                  ${
                    uncategorized.length
                      ? html`
                          <div class="stack">
                            <div class="card-title">Other findings</div>
                            ${uncategorized.map((finding) => renderTaskAuditFinding(finding))}
                          </div>
                        `
                      : nothing
                  }
                `
        }
      </div>
    </div>
  `;
}

function renderSatProtocolMaintenanceCard(props: DebugProps) {
  const busy = props.satProtocolMaintenanceBusy === true;
  return html`
    <div class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">SAT Protocol Maintenance</div>
          <div class="card-sub">
            Operator-only one-shot for reserve refill, fixed-recipient treasury claims, staking distributor feed, and staking SOL claim.
          </div>
        </div>
        <span class="chip chip-warn">advanced</span>
      </div>
      <div class="callout warn" style="margin-top: 12px;">
        This does not start mining and does not choose a cycle keeper. It only submits permissionless
        protocol maintenance transactions when on-chain thresholds are met.
      </div>
      <div class="row" style="margin-top: 12px;">
        <button
          class="btn primary"
          ?disabled=${busy || !props.onSatProtocolMaintenance}
          @click=${() => props.onSatProtocolMaintenance?.()}
        >
          ${busy ? "Running..." : "Run maintenance once"}
        </button>
      </div>
      ${
        props.satProtocolMaintenanceError
          ? html`<div class="callout danger" style="margin-top: 12px;">
              ${props.satProtocolMaintenanceError}
            </div>`
          : nothing
      }
      ${
        props.satProtocolMaintenanceResult
          ? html`<pre class="code-block" style="margin-top: 12px;">${props.satProtocolMaintenanceResult}</pre>`
          : nothing
      }
    </div>
  `;
}

function renderManualRpcCard(props: DebugProps) {
  return html`
    <div class="card">
      <div class="card-title">Manual RPC</div>
      <div class="card-sub">Send a raw gateway method with JSON params.</div>
      <div class="callout warn" style="margin-top: 12px;">
        Expert path. Prefer the dedicated status/control cards above so scope, audit, and
        confirmation rules stay visible.
      </div>
      <div class="stack" style="margin-top: 16px;">
        <label class="field">
          <span>Method</span>
          <select
            .value=${props.callMethod}
            @change=${(e: Event) => props.onCallMethodChange((e.target as HTMLSelectElement).value)}
          >
            ${
              !props.callMethod
                ? html`
                    <option value="" disabled>Select a method...</option>
                  `
                : nothing
            }
            ${props.methods.map((m) => html`<option value=${m}>${m}</option>`)}
          </select>
        </label>
        <label class="field">
          <span>Params (JSON)</span>
          <textarea
            .value=${props.callParams}
            @input=${(e: Event) =>
              props.onCallParamsChange((e.target as HTMLTextAreaElement).value)}
            rows="6"
          ></textarea>
        </label>
      </div>
      <div class="row" style="margin-top: 12px;">
        <button class="btn primary" @click=${props.onCall}>${t("common.call")}</button>
      </div>
      ${
        props.callError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.callError}</div>`
          : nothing
      }
      ${
        props.callResult
          ? html`<pre class="code-block" style="margin-top: 12px;">${props.callResult}</pre>`
          : nothing
      }
    </div>
  `;
}

function renderFeeOpsCard(props: DebugProps) {
  const feeOpsLoading = props.feeOpsLoading === true;
  const feeCollectionStatus = props.feeCollectionStatus ?? [];
  const feeObjects = props.feeObjects ?? [];
  const feeBucketJournal = props.feeBucketJournal ?? [];
  const feeBucketBalances = props.feeBucketBalances ?? [];
  const feeReconciliationReports = props.feeReconciliationReports ?? [];
  const feeAutoDecisions = props.feeAutoDecisions ?? [];
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Network Fee Ops</div>
          <div class="card-sub">
            Read-only fee collection state and reserve accounting. Collection remains gated off until retained-history thresholds are met.
          </div>
        </div>
        <span class="chip ${feeOpsLoading ? "chip-warn" : ""}">${feeOpsLoading ? "refreshing" : "read-only"}</span>
      </div>
      ${
        props.feeOpsError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.feeOpsError}</div>`
          : nothing
      }
      ${
        feeCollectionStatus.length === 0 &&
        feeObjects.length === 0 &&
        feeBucketJournal.length === 0 &&
        feeBucketBalances.length === 0 &&
        feeReconciliationReports.length === 0 &&
        feeAutoDecisions.length === 0
          ? html`
              <div class="muted" style="margin-top: 12px">No operator activity fee data loaded yet.</div>
            `
          : html`
              <div class="stack" style="margin-top: 12px;">
                <div>
                  <div class="muted">Collection status</div>
                  <div class="list" style="margin-top: 8px;">
                    ${feeCollectionStatus.map(
                      (entry) => html`
                        <div class="list-item">
                          <div class="list-main">
                            <div class="list-title">
                              ${entry.lane}
                              <span class="chip ${entry.enabled ? "chip-ok" : "chip-warn"}">
                                ${entry.enabled ? "enabled" : "disabled"}
                              </span>
                            </div>
                            <div class="list-sub">${entry.reason ?? "Threshold state loaded."}</div>
                            <div class="muted" style="margin-top: 6px;">${formatFeeThresholds(entry)}</div>
                          </div>
                        </div>
                      `,
                    )}
                  </div>
                </div>
                <div>
                  <div class="muted">Reserve balances</div>
                  <pre class="code-block">${JSON.stringify(feeBucketBalances, null, 2)}</pre>
                </div>
                <div>
                  <div class="muted">Recent fee objects</div>
                  <pre class="code-block">${JSON.stringify(feeObjects, null, 2)}</pre>
                </div>
                <div>
                  <div class="muted">Bucket journal</div>
                  <pre class="code-block">${JSON.stringify(feeBucketJournal, null, 2)}</pre>
                </div>
                <div>
                  <div class="muted">Reconciliation reports</div>
                  <pre class="code-block">${JSON.stringify(feeReconciliationReports, null, 2)}</pre>
                </div>
                <div>
                  <div class="muted">Auto fee decisions</div>
                  <pre class="code-block">${JSON.stringify(feeAutoDecisions, null, 2)}</pre>
                </div>
              </div>
            `
      }
    </section>
  `;
}

function renderModelsCard(models: unknown[]) {
  return html`
    <section class="card">
      <div class="card-title">Models</div>
      <div class="card-sub">Catalog from models.list.</div>
      <pre class="code-block" style="margin-top: 12px;">
${JSON.stringify(models ?? [], null, 2)}</pre
      >
    </section>
  `;
}

function renderEventLogCard(props: DebugProps) {
  return html`
    <section class="card">
      <div class="card-title">Event Log</div>
      <div class="card-sub">Latest gateway events.</div>
      ${
        props.eventLog.length === 0
          ? html`
              <div class="muted" style="margin-top: 12px">No events yet.</div>
            `
          : html`
              <div class="list debug-event-log" style="margin-top: 12px;">
                ${props.eventLog.map(
                  (evt) => html`
                    <div class="list-item debug-event-log__item">
                      <div class="list-main">
                        <div class="list-title">${evt.event}</div>
                        <div class="list-sub">${new Date(evt.ts).toLocaleTimeString()}</div>
                      </div>
                      <div class="list-meta debug-event-log__meta">
                        <pre class="code-block debug-event-log__payload">
${formatEventPayload(evt.payload)}</pre
                        >
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
      }
    </section>
  `;
}

export function renderDebug(props: DebugProps) {
  const securityAudit =
    props.status && typeof props.status === "object"
      ? (props.status as { securityAudit?: { summary?: Record<string, number> } }).securityAudit
      : null;
  const securitySummary = securityAudit?.summary ?? null;
  const critical = securitySummary?.critical ?? 0;
  const warn = securitySummary?.warn ?? 0;
  const info = securitySummary?.info ?? 0;
  const securityCalloutTone = critical > 0 ? "danger" : warn > 0 ? "warn" : "success";
  const securitySectionTone: DebugSectionTone = critical > 0 ? "danger" : warn > 0 ? "warn" : "ok";
  const securityLabel =
    critical > 0 ? `${critical} critical` : warn > 0 ? `${warn} warnings` : "No critical issues";
  const startup = readGatewayStartup(props.status);
  const strictAgentic = readStrictAgenticStatus(props.status);
  const acpxBridge = readAcpxBridgeStatus(props.status);
  const readOnlyLoaded = [
    props.modelCatalogStatus,
    props.commandsCatalog,
    props.pluginsMarketplace,
    props.diagnosticsStability,
    props.memoryInventory ?? props.memoryValidation ?? props.memoryRepairPreview,
    startup,
    strictAgentic,
  ].filter(Boolean).length;
  const plugins = props.pluginsMarketplace?.plugins ?? [];
  const pluginErrors = plugins.filter((entry) => entry.status === "error").length;
  const pluginRestartPending = plugins.filter(
    (entry) => entry.managed && entry.enabled && !entry.loaded,
  ).length;
  const pluginUpdates = plugins.filter((entry) => entry.actions.includes("update")).length;
  const memoryErrors = props.memoryValidation?.summary.errors ?? 0;
  const memoryWarnings = props.memoryValidation?.summary.warnings ?? 0;
  const memoryProposals = props.memoryRepairPreview?.summary.proposals ?? 0;
  const diagnosticsEvents = props.diagnosticsStability?.count ?? 0;
  const taskLedgerFindings = props.taskLedger?.audit?.findings ?? [];
  const taskLedgerWarnings = taskLedgerFindings.filter(
    (finding) => finding.severity !== "info",
  ).length;
  const taskLedgerActive =
    (props.taskLedger?.summary.queued ?? 0) + (props.taskLedger?.summary.running ?? 0);
  const feeDataCount =
    (props.feeCollectionStatus?.length ?? 0) +
    (props.feeObjects?.length ?? 0) +
    (props.feeBucketJournal?.length ?? 0) +
    (props.feeBucketBalances?.length ?? 0) +
    (props.feeReconciliationReports?.length ?? 0) +
    (props.feeAutoDecisions?.length ?? 0);

  const sections: DebugSection[] = [
    {
      id: "surface-map",
      title: "Debug Surface Map",
      detail: "Operator diagnostics and guarded controls grouped by risk.",
      status: `${readOnlyLoaded} feeds`,
      tone: readOnlyLoaded > 0 ? "ok" : "warn",
      priority: 0,
      open: true,
      content: renderDebugSurfaceMap(props),
    },
    {
      id: "diagnostics-controls",
      title: "Diagnostics Controls",
      detail: "Temporary observability flags, OpenTelemetry, and cache trace.",
      status: readConfigBoolean(props.configForm, ["diagnostics", "enabled"], false)
        ? "diagnostics on"
        : "diagnostics off",
      tone: readConfigBoolean(props.configForm, ["diagnostics", "enabled"], false)
        ? "warn"
        : "neutral",
      priority: 1,
      content: renderDiagnosticsConfigCard(props),
    },
    {
      id: "memory-repair",
      title: "Memory Repair Preview",
      detail: "Memory Doctor inventory, validation, and gated dry-run repairs.",
      status:
        memoryErrors > 0
          ? `${memoryErrors} errors`
          : memoryWarnings > 0
            ? `${memoryWarnings} warnings`
            : `${memoryProposals} proposals`,
      tone: memoryErrors > 0 ? "danger" : memoryWarnings > 0 || memoryProposals > 0 ? "warn" : "ok",
      priority: memoryErrors > 0 || memoryWarnings > 0 ? 1 : 8,
      open: memoryErrors > 0 || memoryWarnings > 0,
      content: renderMemoryDoctorRepairPreviewCard({
        inventory: props.memoryInventory,
        validation: props.memoryValidation,
        preview: props.memoryRepairPreview,
        adminRpcBusy: props.adminRpcBusy,
        onAdminRpcAction: props.onAdminRpcAction,
      }),
    },
    {
      id: "task-ledger",
      title: "Task Ledger",
      detail: "Detached work records, stale-task checks, and cron reconciliation.",
      status: props.taskLedger
        ? taskLedgerWarnings > 0
          ? `${taskLedgerWarnings} warnings`
          : `${taskLedgerActive} active`
        : "not loaded",
      tone: props.taskLedger ? (taskLedgerWarnings > 0 ? "warn" : "ok") : "warn",
      priority: taskLedgerWarnings > 0 ? 2 : 9,
      open: taskLedgerWarnings > 0,
      content: renderTaskLedgerDiagnosticsCard(props),
    },
    {
      id: "sat-protocol-maintenance",
      title: "SAT Protocol Maintenance",
      detail: "Permissionless reserve refill and fixed-recipient protocol lane claims.",
      status: props.satProtocolMaintenanceBusy ? "running" : "one-shot",
      tone: props.satProtocolMaintenanceError ? "danger" : "neutral",
      priority: props.satProtocolMaintenanceError ? 2 : 10,
      open: Boolean(props.satProtocolMaintenanceError || props.satProtocolMaintenanceResult),
      content: renderSatProtocolMaintenanceCard(props),
    },
    {
      id: "plugins",
      title: "Plugin Runtime Status",
      detail: "Marketplace, install, update, runtime state, and diagnostics.",
      status: props.pluginsMarketplace
        ? pluginErrors > 0
          ? `${pluginErrors} errors`
          : pluginRestartPending > 0
            ? `${pluginRestartPending} restart`
            : pluginUpdates > 0
              ? `${pluginUpdates} updates`
              : `${plugins.length} plugins`
        : "not loaded",
      tone: props.pluginsMarketplace
        ? pluginErrors > 0
          ? "danger"
          : pluginRestartPending > 0 || pluginUpdates > 0
            ? "warn"
            : "ok"
        : "warn",
      priority: pluginErrors > 0 ? 2 : pluginRestartPending > 0 ? 3 : 12,
      open: pluginErrors > 0 || pluginRestartPending > 0,
      content: renderPluginMarketplaceCard(props.pluginsMarketplace),
    },
    {
      id: "snapshots",
      title: "Snapshots",
      detail: "Status, health, heartbeat, and security audit summary.",
      status: securitySummary ? securityLabel : props.status ? "status loaded" : "not loaded",
      tone: securitySummary ? securitySectionTone : props.status ? "ok" : "warn",
      priority: critical > 0 ? 4 : warn > 0 ? 5 : 14,
      open: critical > 0 || warn > 0,
      content: renderSnapshotsCard(props, {
        securityTone: securityCalloutTone,
        securityLabel: securitySummary ? securityLabel : "",
        info,
      }),
    },
    {
      id: "diagnostics-stability",
      title: "Diagnostic Stability",
      detail: "Sanitized runtime stability events captured by the gateway.",
      status: props.diagnosticsStability ? `${diagnosticsEvents} events` : "not loaded",
      tone: props.diagnosticsStability ? "ok" : "warn",
      priority: diagnosticsEvents > 0 ? 6 : 18,
      content: renderDiagnosticsStabilityCard(props.diagnosticsStability),
    },
    {
      id: "acpx-push-test",
      title: "ACPX Push-Test Approval",
      detail: "Fixed-wrapper approval and result state for push tests.",
      status: acpxBridge.fasedPushTestRequest.enabled ? "wrapper enabled" : "wrapper disabled",
      tone: acpxBridge.fasedPushTestRequest.enabled ? "warn" : "neutral",
      priority: acpxBridge.fasedPushTestRequest.enabled ? 7 : 28,
      content: renderAcpxPushTestApprovalCard(props),
    },
    {
      id: "acpx-bridge",
      title: "ACPX Bridge Config",
      detail: "Admin-only controls for the Fased-owned MCP bridge.",
      status: acpxBridge.enabled ? acpxBridge.mode : "disabled",
      tone: acpxBridge.fasedPushTestRequest.enabled
        ? "warn"
        : acpxBridge.enabled
          ? "ok"
          : "neutral",
      priority: 20,
      content: renderAcpxBridgeConfigControls(props),
    },
    {
      id: "admin-rpc",
      title: "Admin RPC Controls",
      detail: "Operator-only side-effecting calls with confirmation and audit.",
      status: "admin/write",
      tone: "warn",
      priority: 24,
      content: renderAdminRpcControls(props),
    },
    {
      id: "manual-rpc",
      title: "Manual RPC",
      detail: "Expert raw gateway method path.",
      status: `${props.methods.length} methods`,
      tone: "warn",
      priority: 26,
      content: renderManualRpcCard(props),
    },
    {
      id: "gateway-startup",
      title: "Gateway Startup",
      detail: "Latest gateway startup phase timings from the active process.",
      status: startup ? formatDuration(startup.totalMs) : "not recorded",
      tone: startup ? "ok" : "warn",
      priority: 30,
      content: renderGatewayStartupCard(props.status),
    },
    {
      id: "strict-agentic",
      title: "Strict-Agentic Policy",
      detail: "Warning-only diagnostics for planned-without-action or empty Agent runs.",
      status: strictAgentic
        ? strictAgentic.mode === "warn"
          ? `${strictAgentic.warningAgents}/${strictAgentic.totalAgents} warn`
          : "off"
        : "not loaded",
      tone: strictAgentic?.mode === "warn" ? "warn" : strictAgentic ? "ok" : "neutral",
      priority: strictAgentic?.mode === "warn" ? 9 : 32,
      content: renderStrictAgenticPolicyCard(props.status),
    },
    {
      id: "provider-catalog",
      title: "Provider Catalog",
      detail: "Model catalog source, configured providers, and extension coverage.",
      status: props.modelCatalogStatus
        ? `${props.modelCatalogStatus.availableProviders}/${props.modelCatalogStatus.totalProviders} available`
        : "not loaded",
      tone: props.modelCatalogStatus ? "ok" : "warn",
      priority: 34,
      content: renderProviderCatalogCard(props.modelCatalogStatus),
    },
    {
      id: "commands",
      title: "Command Catalog",
      detail: "Gateway-visible command names, sources, and scopes.",
      status: props.commandsCatalog
        ? `${props.commandsCatalog.commands.length} commands`
        : "not loaded",
      tone: props.commandsCatalog ? "ok" : "warn",
      priority: 36,
      content: renderCommandCatalogCard(props.commandsCatalog),
    },
    {
      id: "fee-ops",
      title: "Network Fee Ops",
      detail: "Read-only fee collection state and reserve accounting.",
      status: props.feeOpsError
        ? "error"
        : feeDataCount > 0
          ? `${feeDataCount} records`
          : "no data",
      tone: props.feeOpsError ? "danger" : feeDataCount > 0 ? "ok" : "neutral",
      priority: props.feeOpsError ? 11 : 42,
      content: renderFeeOpsCard(props),
    },
    {
      id: "models",
      title: "Models",
      detail: "Raw models.list catalog payload.",
      status: `${props.models.length} models`,
      tone: props.models.length > 0 ? "ok" : "neutral",
      priority: 44,
      content: renderModelsCard(props.models),
    },
    {
      id: "event-log",
      title: "Event Log",
      detail: "Latest gateway events.",
      status: props.eventLog.length > 0 ? `${props.eventLog.length} events` : "empty",
      tone: props.eventLog.length > 0 ? "ok" : "neutral",
      priority: props.eventLog.length > 0 ? 13 : 46,
      content: renderEventLogCard(props),
    },
  ];
  const sortedSections = sections.toSorted(
    (left, right) => left.priority - right.priority || left.title.localeCompare(right.title),
  );

  return html`
    <section class="debug-page">
      ${renderDebugStyles()}
      <div class="debug-toolbar">
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("common.refreshing") : t("common.refresh")}
        </button>
      </div>
      <div class="debug-section-list">
        ${sortedSections.map((section) => renderDebugSection(section))}
      </div>
    </section>
  `;
}
