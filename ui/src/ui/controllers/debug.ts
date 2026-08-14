import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  CommandsListResult,
  DiagnosticStabilitySnapshot,
  DoctorMemoryInventoryPayload,
  DoctorMemoryRepairPreviewPayload,
  DoctorMemoryValidationPayload,
  HealthSnapshot,
  ModelsCatalogStatusResult,
  PluginsMarketplaceListResult,
  ConfigSnapshot,
  StatusSummary,
} from "../types.ts";
import { generateUUID } from "../uuid.ts";

export type DebugState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  debugLoading: boolean;
  debugStatus: StatusSummary | null;
  debugHealth: HealthSnapshot | null;
  debugModels: unknown[];
  debugModelCatalogStatus: ModelsCatalogStatusResult | null;
  debugCommandsCatalog: CommandsListResult | null;
  debugPluginsMarketplace: PluginsMarketplaceListResult | null;
  debugDiagnosticsStability: DiagnosticStabilitySnapshot | null;
  debugMemoryInventory: DoctorMemoryInventoryPayload | null;
  debugMemoryValidation: DoctorMemoryValidationPayload | null;
  debugMemoryRepairPreview: DoctorMemoryRepairPreviewPayload | null;
  debugHeartbeat: unknown;
  debugCallMethod: string;
  debugCallParams: string;
  debugCallResult: string | null;
  debugCallError: string | null;
  debugAdminRpcBusy: string | null;
  debugAdminRpcResult: string | null;
  debugAdminRpcError: string | null;
  debugAdminChatSessionKey: string;
  debugAdminChatMessage: string;
  debugAdminPushNodeId: string;
  debugAdminPushTitle: string;
  debugAdminPushBody: string;
  debugAdminWebAccountId: string;
  debugAcpxBridgeConfigBusy: DebugAcpxBridgeConfigAction | null;
  debugAcpxBridgeConfigResult: string | null;
  debugAcpxBridgeConfigError: string | null;
  debugAcpxPushTestBusy: DebugAcpxPushTestAction | null;
  debugAcpxPushTestPreview: DebugAcpxPushTestPreviewPayload | null;
  debugAcpxPushTestAuditHistory: DebugAcpxPushTestAuditHistoryPayload | null;
  debugAcpxPushTestResult: string | null;
  debugAcpxPushTestError: string | null;
  debugSatProtocolMaintenanceBusy: boolean;
  debugSatProtocolMaintenanceResult: string | null;
  debugSatProtocolMaintenanceError: string | null;
};

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

const ACPX_PUSH_TEST_TOOL_NAME = "fased_push_test_request";
const SAT_MAINTENANCE_IDEMPOTENCY_KEY = "fased.sat.maintenance.pending-idempotency.v1";

const UNSAFE_MEMORY_DOCTOR_FIELD_KEYS = new Set([
  "apply",
  "auditPath",
  "backupPath",
  "body",
  "cli",
  "command",
  "confirmation",
  "content",
  "endpoint",
  "execute",
  "executor",
  "fsOperation",
  "gatewayHandler",
  "handler",
  "href",
  "method",
  "params",
  "request",
  "rollbackPath",
  "route",
  "token",
  "transcript",
  "url",
  "writePath",
]);

function stripUnsafeMemoryDoctorFields(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripUnsafeMemoryDoctorFields(entry));
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !UNSAFE_MEMORY_DOCTOR_FIELD_KEYS.has(key))
      .map(([key, entry]) => [key, stripUnsafeMemoryDoctorFields(entry)]),
  );
}

function claimSatMaintenanceIdempotencyKey(): string {
  let storage: Storage;
  try {
    storage = globalThis.localStorage;
  } catch {
    throw new Error("Durable browser storage is required before SAT maintenance can run");
  }
  if (!storage) {
    throw new Error("Durable browser storage is required before SAT maintenance can run");
  }
  const existing = storage.getItem(SAT_MAINTENANCE_IDEMPOTENCY_KEY)?.trim();
  if (existing) {
    if (existing.length > 160 || /[^\x20-\x7e]/u.test(existing)) {
      throw new Error("Stored SAT maintenance idempotency key is invalid");
    }
    return existing;
  }
  const idempotencyKey = `sat-maintain-ui-${generateUUID()}`;
  storage.setItem(SAT_MAINTENANCE_IDEMPOTENCY_KEY, idempotencyKey);
  return idempotencyKey;
}

function completeSatMaintenanceIdempotencyKey(idempotencyKey: string): void {
  const storage = globalThis.localStorage;
  if (storage?.getItem(SAT_MAINTENANCE_IDEMPOTENCY_KEY) === idempotencyKey) {
    storage.removeItem(SAT_MAINTENANCE_IDEMPOTENCY_KEY);
  }
}

export async function loadDebug(state: DebugState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.debugLoading) {
    return;
  }
  state.debugLoading = true;
  try {
    const [
      status,
      health,
      models,
      modelCatalogStatus,
      commandsCatalog,
      pluginsMarketplace,
      diagnosticsStability,
      memoryInventory,
      memoryValidation,
      memoryRepairPreview,
      acpxPushTestAuditHistory,
      heartbeat,
    ] = await Promise.allSettled([
      state.client.request("status", {}),
      state.client.request("health", {}),
      state.client.request("models.list", {}),
      state.client.request("models.catalog.status", {}),
      state.client.request("commands.list", { scope: "both", includeArgs: false }),
      state.client.request("plugins.marketplace.list", {}),
      state.client.request("diagnostics.stability", { limit: 25 }),
      state.client.request("doctor.memory.inventory", {}),
      state.client.request("doctor.memory.validate", {}),
      state.client.request("doctor.memory.repair.preview", {}),
      state.client.request("acpx.pushTest.auditHistory", { limit: 12 }),
      state.client.request("last-heartbeat", {}),
    ]);

    if (status.status === "fulfilled") {
      state.debugStatus = status.value as StatusSummary;
    }
    if (health.status === "fulfilled") {
      state.debugHealth = health.value as HealthSnapshot;
    }
    if (models.status === "fulfilled") {
      const modelPayload = models.value as { models?: unknown[] } | undefined;
      state.debugModels = Array.isArray(modelPayload?.models) ? modelPayload?.models : [];
    }
    if (modelCatalogStatus.status === "fulfilled") {
      state.debugModelCatalogStatus = modelCatalogStatus.value as ModelsCatalogStatusResult;
    }
    if (commandsCatalog.status === "fulfilled") {
      state.debugCommandsCatalog = commandsCatalog.value as CommandsListResult;
    }
    if (pluginsMarketplace.status === "fulfilled") {
      state.debugPluginsMarketplace = pluginsMarketplace.value as PluginsMarketplaceListResult;
    }
    if (diagnosticsStability.status === "fulfilled") {
      state.debugDiagnosticsStability = diagnosticsStability.value as DiagnosticStabilitySnapshot;
    }
    if (memoryInventory.status === "fulfilled") {
      state.debugMemoryInventory = stripUnsafeMemoryDoctorFields(
        memoryInventory.value,
      ) as DoctorMemoryInventoryPayload;
    }
    if (memoryValidation.status === "fulfilled") {
      state.debugMemoryValidation = stripUnsafeMemoryDoctorFields(
        memoryValidation.value,
      ) as DoctorMemoryValidationPayload;
    }
    if (memoryRepairPreview.status === "fulfilled") {
      state.debugMemoryRepairPreview = stripUnsafeMemoryDoctorFields(
        memoryRepairPreview.value,
      ) as DoctorMemoryRepairPreviewPayload;
    }
    if (acpxPushTestAuditHistory.status === "fulfilled") {
      state.debugAcpxPushTestAuditHistory =
        acpxPushTestAuditHistory.value as DebugAcpxPushTestAuditHistoryPayload;
    }
    if (heartbeat.status === "fulfilled") {
      state.debugHeartbeat = heartbeat.value;
    }

    const firstError = [
      status,
      health,
      models,
      modelCatalogStatus,
      commandsCatalog,
      pluginsMarketplace,
      diagnosticsStability,
      memoryInventory,
      memoryValidation,
      memoryRepairPreview,
      acpxPushTestAuditHistory,
      heartbeat,
    ].find((entry) => entry.status === "rejected");
    if (firstError?.status === "rejected") {
      state.debugCallError = String(firstError.reason);
    }
  } catch (err) {
    state.debugCallError = String(err);
  } finally {
    state.debugLoading = false;
  }
}

export async function callDebugMethod(state: DebugState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.debugCallError = null;
  state.debugCallResult = null;
  try {
    const params = state.debugCallParams.trim()
      ? (JSON.parse(state.debugCallParams) as unknown)
      : {};
    const res = await state.client.request(state.debugCallMethod.trim(), params);
    state.debugCallResult = JSON.stringify(res, null, 2);
  } catch (err) {
    state.debugCallError = String(err);
  }
}

export async function callDebugSatProtocolMaintenance(state: DebugState) {
  if (!state.client || !state.connected || state.debugSatProtocolMaintenanceBusy) {
    return;
  }
  const confirm = (globalThis as { confirm?: (message?: string) => boolean }).confirm;
  if (!confirm) {
    state.debugSatProtocolMaintenanceError = "Confirmation is unavailable in this runtime";
    return;
  }
  if (
    !confirm(
      "Run one SAT protocol maintenance pass? This can submit fixed-recipient reserve, treasury, and staking transactions when on-chain thresholds are met.",
    )
  ) {
    return;
  }
  state.debugSatProtocolMaintenanceBusy = true;
  state.debugSatProtocolMaintenanceError = null;
  state.debugSatProtocolMaintenanceResult = null;
  try {
    const idempotencyKey = claimSatMaintenanceIdempotencyKey();
    const res = await state.client.request("sat.runProtocolMaintenanceOnce", { idempotencyKey });
    completeSatMaintenanceIdempotencyKey(idempotencyKey);
    state.debugSatProtocolMaintenanceResult = JSON.stringify(res, null, 2);
  } catch (err) {
    state.debugSatProtocolMaintenanceError = String(err);
  } finally {
    state.debugSatProtocolMaintenanceBusy = false;
  }
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function buildDebugAdminRpcParams(state: DebugState, action: DebugAdminRpcAction) {
  switch (action) {
    case "chat.inject":
      return {
        sessionKey: requireText(state.debugAdminChatSessionKey, "Session key"),
        message: requireText(state.debugAdminChatMessage, "Message"),
        label: "operator-dashboard",
      };
    case "push.test":
      return {
        nodeId: requireText(state.debugAdminPushNodeId, "Node id"),
        title: state.debugAdminPushTitle.trim() || "Fased test push",
        body: state.debugAdminPushBody.trim() || "Operator test push",
      };
    case "doctor.memory.repair.execute": {
      const proposalIds =
        state.debugMemoryRepairPreview?.proposals
          .filter((proposal) => proposal.supported)
          .map((proposal) => proposal.id) ?? [];
      if (proposalIds.length === 0) {
        throw new Error("No supported Memory Doctor repair proposals are available");
      }
      return {
        agentId: state.debugMemoryRepairPreview?.agentId,
        proposalIds,
        confirm: "EXECUTE_MEMORY_REPAIR",
        acceptCurrentPreview: true,
        acceptCurrentAuditPlan: true,
      };
    }
    case "web.login.start":
      return {
        accountId: state.debugAdminWebAccountId.trim() || undefined,
        force: true,
      };
    case "web.login.wait":
      return {
        accountId: state.debugAdminWebAccountId.trim() || undefined,
      };
  }
}

function buildDebugAcpxPushTestParams(state: DebugState): Record<string, unknown> {
  return {
    nodeId: requireText(state.debugAdminPushNodeId, "Node id"),
    title: state.debugAdminPushTitle.trim() || "Fased test push",
    body: state.debugAdminPushBody.trim() || "Operator test push",
  };
}

function describeDebugAdminRpcAction(action: DebugAdminRpcAction): string {
  switch (action) {
    case "chat.inject":
      return "Inject an operator-labeled assistant message into this session transcript?";
    case "push.test":
      return "Send a real APNs test push to this registered node?";
    case "doctor.memory.repair.execute":
      return "Execute all currently supported Memory Doctor repair proposals? This writes memory artifact files/directories and records backup/audit metadata.";
    case "web.login.start":
      return "Start a web login QR flow for this provider account? This may stop the current channel runtime first.";
    case "web.login.wait":
      return "Wait for the active web login flow and restart the provider account if it connected?";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeToolList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function addTool(value: string[], tool: string): string[] {
  return [...new Set([...value, tool])].toSorted((left, right) => left.localeCompare(right));
}

function removeTool(value: string[], tool: string): string[] {
  return value.filter((entry) => entry !== tool);
}

function readAcpxMcpBridgeConfig(config: Record<string, unknown> | null | undefined) {
  const plugins = asRecord(config?.plugins);
  const entries = asRecord(plugins.entries);
  const acpx = asRecord(entries.acpx);
  const pluginConfig = asRecord(acpx.config);
  const bridge = asRecord(pluginConfig.mcpBridge);
  return {
    enabled: bridge.enabled === true,
    mode:
      bridge.mode === "status-only" ||
      bridge.mode === "read-only-tools" ||
      bridge.mode === "operator-approved-mutating-tools"
        ? bridge.mode
        : "status-only",
    allowTools: normalizeToolList(bridge.allowTools),
    denyTools: normalizeToolList(bridge.denyTools),
  };
}

function buildAcpxBridgeConfigPatch(
  config: Record<string, unknown> | null | undefined,
  action: DebugAcpxBridgeConfigAction,
) {
  const current = readAcpxMcpBridgeConfig(config);
  let enabled = current.enabled;
  let mode = current.mode;
  let allowTools = [...current.allowTools];
  let denyTools = [...current.denyTools];
  let acpxEntryEnabled: boolean | undefined;

  switch (action) {
    case "disable":
      enabled = false;
      mode = "status-only";
      allowTools = removeTool(allowTools, ACPX_PUSH_TEST_TOOL_NAME);
      break;
    case "status-only":
      enabled = true;
      mode = "status-only";
      allowTools = removeTool(allowTools, ACPX_PUSH_TEST_TOOL_NAME);
      break;
    case "read-only-tools":
      enabled = true;
      mode = "read-only-tools";
      allowTools = removeTool(allowTools, ACPX_PUSH_TEST_TOOL_NAME);
      denyTools = addTool(denyTools, ACPX_PUSH_TEST_TOOL_NAME);
      break;
    case "enable-push-test":
      enabled = true;
      mode = "operator-approved-mutating-tools";
      allowTools = addTool(allowTools, ACPX_PUSH_TEST_TOOL_NAME);
      denyTools = removeTool(denyTools, ACPX_PUSH_TEST_TOOL_NAME);
      acpxEntryEnabled = true;
      break;
    case "deny-push-test":
      allowTools = removeTool(allowTools, ACPX_PUSH_TEST_TOOL_NAME);
      denyTools = addTool(denyTools, ACPX_PUSH_TEST_TOOL_NAME);
      break;
  }

  return {
    plugins: {
      entries: {
        acpx: {
          ...(acpxEntryEnabled === undefined ? {} : { enabled: acpxEntryEnabled }),
          config: {
            mcpBridge: {
              enabled,
              mode,
              allowTools,
              denyTools,
            },
          },
        },
      },
    },
  };
}

function describeAcpxBridgeConfigAction(action: DebugAcpxBridgeConfigAction): string {
  switch (action) {
    case "disable":
      return "Disable the Fased-owned ACPX MCP bridge? This removes the push-test allowlist entry and exposes no ACPX MCP tools.";
    case "status-only":
      return "Enable ACPX status-only bridge mode? This exposes status preview only and keeps fased_push_test_request disabled.";
    case "read-only-tools":
      return "Enable ACPX read-only tools mode? This keeps fased_push_test_request denied and exposes no mutating wrapper.";
    case "enable-push-test":
      return "Enable operator-approved ACPX mutating bridge mode for fased_push_test_request? This fixed wrapper still requires the local bridge token, operator approval, rate limit, and audit.";
    case "deny-push-test":
      return "Deny fased_push_test_request in ACPX bridge config? This removes it from allowTools and adds it to denyTools.";
  }
}

function acpxBridgeConfigActionSummary(action: DebugAcpxBridgeConfigAction): string {
  switch (action) {
    case "disable":
      return "ACPX MCP bridge disabled.";
    case "status-only":
      return "ACPX MCP bridge set to status-only.";
    case "read-only-tools":
      return "ACPX MCP bridge set to read-only-tools with push-test denied.";
    case "enable-push-test":
      return "ACPX MCP bridge set to operator-approved mutating tools with fased_push_test_request allowlisted.";
    case "deny-push-test":
      return "fased_push_test_request denied in ACPX MCP bridge config.";
  }
}

export async function callDebugAdminRpcControl(state: DebugState, action: DebugAdminRpcAction) {
  if (!state.client || !state.connected || state.debugAdminRpcBusy) {
    return;
  }
  state.debugAdminRpcError = null;
  state.debugAdminRpcResult = null;
  let params: Record<string, unknown>;
  try {
    params = buildDebugAdminRpcParams(state, action);
  } catch (err) {
    state.debugAdminRpcError = String(err);
    return;
  }
  const confirm = (globalThis as { confirm?: (message?: string) => boolean }).confirm;
  if (!confirm) {
    state.debugAdminRpcError = "Confirmation is unavailable in this runtime";
    return;
  }
  if (!confirm(describeDebugAdminRpcAction(action))) {
    return;
  }
  state.debugAdminRpcBusy = action;
  try {
    const res = await state.client.request(action, params);
    state.debugAdminRpcResult = JSON.stringify(
      {
        method: action,
        ok: true,
        audit: "sanitized mutating-admin-rpc audit event written by gateway",
        result: res,
      },
      null,
      2,
    );
  } catch (err) {
    state.debugAdminRpcError = String(err);
  } finally {
    state.debugAdminRpcBusy = null;
  }
}

export async function updateDebugAcpxBridgeConfig(
  state: DebugState,
  action: DebugAcpxBridgeConfigAction,
) {
  if (!state.client || !state.connected || state.debugAcpxBridgeConfigBusy) {
    return;
  }
  state.debugAcpxBridgeConfigError = null;
  state.debugAcpxBridgeConfigResult = null;

  const confirm = (globalThis as { confirm?: (message?: string) => boolean }).confirm;
  if (!confirm) {
    state.debugAcpxBridgeConfigError = "Confirmation is unavailable in this runtime";
    return;
  }
  if (!confirm(describeAcpxBridgeConfigAction(action))) {
    return;
  }

  state.debugAcpxBridgeConfigBusy = action;
  try {
    const snapshot = await state.client.request<ConfigSnapshot>("config.get", {});
    const baseHash = snapshot.hash;
    if (!baseHash) {
      throw new Error("Config hash missing; refresh and retry.");
    }
    const config =
      snapshot.config && typeof snapshot.config === "object" && !Array.isArray(snapshot.config)
        ? snapshot.config
        : {};
    const patch = buildAcpxBridgeConfigPatch(config, action);
    const res = await state.client.request("config.patch", {
      baseHash,
      raw: JSON.stringify(patch),
      note: acpxBridgeConfigActionSummary(action),
    });
    state.debugAcpxBridgeConfigResult = JSON.stringify(
      {
        ok: true,
        action,
        summary: acpxBridgeConfigActionSummary(action),
        result: res,
      },
      null,
      2,
    );
    await loadDebug(state);
  } catch (err) {
    state.debugAcpxBridgeConfigError = String(err);
  } finally {
    state.debugAcpxBridgeConfigBusy = null;
  }
}

export async function callDebugAcpxPushTest(state: DebugState, action: DebugAcpxPushTestAction) {
  if (!state.client || !state.connected || state.debugAcpxPushTestBusy) {
    return;
  }
  state.debugAcpxPushTestError = null;
  if (action === "preview") {
    state.debugAcpxPushTestPreview = null;
    state.debugAcpxPushTestResult = null;
  }
  let params: Record<string, unknown>;
  try {
    params = buildDebugAcpxPushTestParams(state);
  } catch (err) {
    state.debugAcpxPushTestError = String(err);
    return;
  }

  if (action === "execute") {
    const fingerprint = state.debugAcpxPushTestPreview?.response.requestFingerprint;
    if (!fingerprint) {
      state.debugAcpxPushTestError = "Preview the ACPX push-test approval request first.";
      return;
    }
    const confirm = (globalThis as { confirm?: (message?: string) => boolean }).confirm;
    if (!confirm) {
      state.debugAcpxPushTestError = "Confirmation is unavailable in this runtime";
      return;
    }
    if (
      !confirm(
        `Approve and execute fased_push_test_request for node ${String(
          params.nodeId,
        )}? The accepted fingerprint is ${fingerprint.slice(0, 16)}...`,
      )
    ) {
      return;
    }
    params = {
      ...params,
      confirm: "EXECUTE_ACPX_PUSH_TEST",
      acceptedRequestFingerprint: fingerprint,
    };
  }

  state.debugAcpxPushTestBusy = action;
  try {
    const res = await state.client.request(
      action === "preview" ? "acpx.pushTest.preview" : "acpx.pushTest.execute",
      params,
    );
    if (action === "preview") {
      state.debugAcpxPushTestPreview = res as DebugAcpxPushTestPreviewPayload;
      return;
    }
    state.debugAcpxPushTestResult = JSON.stringify(res, null, 2);
    await loadDebug(state);
  } catch (err) {
    state.debugAcpxPushTestError = String(err);
  } finally {
    state.debugAcpxPushTestBusy = null;
  }
}
