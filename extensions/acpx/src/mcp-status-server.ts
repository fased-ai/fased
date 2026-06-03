import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FasedAgentPluginServiceContext, PluginLogger } from "fased/plugin-sdk";
import { z } from "zod";
import {
  ACPX_PUSH_TEST_METHOD,
  ACPX_PUSH_TEST_WRAPPER_ID,
  type AcpxPushTestApprovalContractRequest,
} from "../../../src/acp/acpx-push-test-approval-contract.js";
import {
  executeAcpxPushTestRequest,
  type AcpxPushTestExecutionAdapterResult,
} from "../../../src/acp/acpx-push-test-execution-adapter.js";
import type {
  GatewayClient,
  GatewayRequestContext,
} from "../../../src/gateway/server-methods/types.js";
import type { ResolvedAcpxMcpBridgeConfig } from "./config.js";
import {
  ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME,
  resolveAcpxMcpMutatingToolDefinitions,
  type AcpxPushTestMcpToolExecutionAdapter,
} from "./mcp-mutating-tool-registry.js";
import {
  ACPX_ACP_STATUS_MCP_TOOL_NAME,
  ACPX_COMMANDS_LIST_MCP_TOOL_NAME,
  ACPX_GATEWAY_IDENTITY_MCP_TOOL_NAME,
  ACPX_GATEWAY_STATUS_MCP_TOOL_NAME,
  ACPX_MODELS_CATALOG_STATUS_MCP_TOOL_NAME,
  ACPX_STATUS_MCP_TOOL_NAME,
  ACPX_UPDATE_STATUS_MCP_TOOL_NAME,
  resolveAcpxMcpBridgeToolDefinitions,
} from "./mcp-readonly-tool-registry.js";

export { ACPX_STATUS_MCP_TOOL_NAME } from "./mcp-readonly-tool-registry.js";

type RawEffectiveToolEntry = {
  id?: unknown;
  label?: unknown;
  description?: unknown;
  source?: unknown;
  pluginId?: unknown;
  channelId?: unknown;
};

type RawEffectiveToolGroup = {
  id?: unknown;
  label?: unknown;
  source?: unknown;
  tools?: unknown;
};

type RawEffectiveToolInventoryResult = {
  agentId?: unknown;
  profile?: unknown;
  groups?: unknown;
};

type RawPublicGatewayIdentity = {
  deviceId?: unknown;
  publicKey?: unknown;
};

type RawGatewayStatusResult = {
  gatewayStartup?: unknown;
  linkChannel?: unknown;
  heartbeat?: unknown;
  channelSummary?: unknown;
  queuedSystemEvents?: unknown;
  sessions?: unknown;
};

type RawGatewayStartupStatus = {
  entries?: unknown;
  totalMs?: unknown;
  summary?: unknown;
  recordedAtMs?: unknown;
};

type RawGatewayStartupStatusEntry = {
  name?: unknown;
  durationMs?: unknown;
};

type RawGatewayLinkChannelStatus = {
  id?: unknown;
  label?: unknown;
  linked?: unknown;
  authAgeMs?: unknown;
};

type RawGatewayHeartbeatStatus = {
  defaultAgentId?: unknown;
  agents?: unknown;
};

type RawGatewayHeartbeatAgentStatus = {
  agentId?: unknown;
  enabled?: unknown;
  every?: unknown;
  everyMs?: unknown;
};

type RawGatewaySessionsStatus = {
  count?: unknown;
  defaults?: unknown;
  byAgent?: unknown;
  paths?: unknown;
  recent?: unknown;
};

type RawGatewaySessionDefaultsStatus = {
  model?: unknown;
  contextTokens?: unknown;
};

type RawGatewaySessionAgentStatus = {
  agentId?: unknown;
  count?: unknown;
};

type RawModelsCatalogStatusResult = {
  totalProviders?: unknown;
  totalModels?: unknown;
  configuredProviders?: unknown;
  availableProviders?: unknown;
  reasoningModels?: unknown;
  visionModels?: unknown;
  sourceCounts?: unknown;
  providers?: unknown;
};

type RawModelsCatalogProviderStatus = {
  provider?: unknown;
  totalModels?: unknown;
  configured?: unknown;
  reasoningModels?: unknown;
  visionModels?: unknown;
  sources?: unknown;
};

type RawUpdateStatusResult = {
  ok?: unknown;
  update?: unknown;
  availability?: unknown;
  channel?: unknown;
  probes?: unknown;
  summary?: unknown;
};

type RawUpdateStatusUpdate = {
  installKind?: unknown;
  packageManager?: unknown;
  git?: unknown;
  deps?: unknown;
  registry?: unknown;
};

type RawUpdateStatusGit = {
  sha?: unknown;
  tag?: unknown;
  branch?: unknown;
  upstream?: unknown;
  dirty?: unknown;
  ahead?: unknown;
  behind?: unknown;
  fetchOk?: unknown;
  error?: unknown;
};

type RawUpdateStatusDeps = {
  manager?: unknown;
  status?: unknown;
  reason?: unknown;
};

type RawUpdateStatusRegistry = {
  latestVersion?: unknown;
  error?: unknown;
};

type RawUpdateAvailability = {
  available?: unknown;
  hasGitUpdate?: unknown;
  hasRegistryUpdate?: unknown;
  latestVersion?: unknown;
  gitBehind?: unknown;
};

type RawUpdateChannel = {
  channel?: unknown;
  source?: unknown;
  label?: unknown;
  config?: unknown;
};

type RawUpdateProbes = {
  fetchGit?: unknown;
  includeRegistry?: unknown;
  timeoutMs?: unknown;
};

type RawCommandsListResult = {
  commands?: unknown;
};

type RawCommandEntry = {
  name?: unknown;
  nativeName?: unknown;
  textAliases?: unknown;
  description?: unknown;
  category?: unknown;
  source?: unknown;
  scope?: unknown;
  acceptsArgs?: unknown;
  args?: unknown;
};

type RawCommandArg = {
  name?: unknown;
  description?: unknown;
  type?: unknown;
  required?: unknown;
  choices?: unknown;
  dynamic?: unknown;
};

type RawCommandArgChoice = {
  value?: unknown;
  label?: unknown;
};

type RawAcpStatusResult = {
  policy?: unknown;
  runtimeBackend?: unknown;
  manager?: unknown;
  sessions?: unknown;
};

type RawAcpStatusPolicy = {
  enabled?: unknown;
  dispatchEnabled?: unknown;
  backend?: unknown;
  defaultAgent?: unknown;
  allowedAgents?: unknown;
  maxConcurrentSessions?: unknown;
};

type RawAcpStatusRuntimeBackend = {
  requestedId?: unknown;
  registered?: unknown;
  selectedId?: unknown;
  healthy?: unknown;
};

type RawAcpStatusManager = {
  runtimeCache?: unknown;
  turns?: unknown;
  errorsByCode?: unknown;
};

type RawAcpStatusRuntimeCache = {
  activeSessions?: unknown;
  idleTtlMs?: unknown;
  evictedTotal?: unknown;
  lastEvictedAt?: unknown;
};

type RawAcpStatusTurns = {
  active?: unknown;
  queueDepth?: unknown;
  completed?: unknown;
  failed?: unknown;
  averageLatencyMs?: unknown;
  maxLatencyMs?: unknown;
};

type RawAcpStatusSessions = {
  total?: unknown;
  returned?: unknown;
  limit?: unknown;
  items?: unknown;
};

type RawAcpStatusSession = {
  sessionKey?: unknown;
  backend?: unknown;
  agent?: unknown;
  mode?: unknown;
  state?: unknown;
  lastActivityAt?: unknown;
  lastError?: unknown;
  identity?: unknown;
  runtimeOptions?: unknown;
};

type RawAcpStatusIdentity = {
  state?: unknown;
  source?: unknown;
  acpxRecordId?: unknown;
  acpxSessionId?: unknown;
  agentSessionId?: unknown;
  lastUpdatedAt?: unknown;
};

type RawAcpStatusRuntimeOptions = {
  runtimeMode?: unknown;
  model?: unknown;
  permissionProfile?: unknown;
  timeoutSeconds?: unknown;
  backendExtrasKeys?: unknown;
  cwdConfigured?: unknown;
};

type CommandScope = "native" | "text" | "both";
type AcpSessionMode = "persistent" | "oneshot";
type AcpSessionState = "idle" | "running" | "error";
type AcpIdentityState = "pending" | "resolved";
type AcpIdentitySource = "ensure" | "status" | "event";

export type AcpxEffectiveToolPreviewEntry = {
  id: string;
  label: string;
  description: string;
  source: string;
  pluginId?: string;
  channelId?: string;
};

export type AcpxEffectiveToolPreviewGroup = {
  id: string;
  label: string;
  source: string;
  tools: AcpxEffectiveToolPreviewEntry[];
};

export type AcpxToolsEffectivePreview = {
  bridge: {
    id: "acpx";
    mode: ResolvedAcpxMcpBridgeConfig["mode"];
    enabled: true;
  };
  agentId: string;
  profile: string;
  groups: AcpxEffectiveToolPreviewGroup[];
};

export type AcpxGatewayIdentityPreview = {
  bridge: {
    id: "acpx";
    mode: ResolvedAcpxMcpBridgeConfig["mode"];
    enabled: true;
  };
  source: "gateway.identity.get";
  gateway: {
    deviceId: string;
    publicKey: string;
  };
};

export type AcpxGatewayStatusPreview = {
  bridge: {
    id: "acpx";
    mode: ResolvedAcpxMcpBridgeConfig["mode"];
    enabled: true;
  };
  source: "status";
  gatewayStartup: {
    entries: Array<{
      name: string;
      durationMs: number;
    }>;
    totalMs: number | null;
    summary: string | null;
    recordedAtMs: number | null;
  } | null;
  linkChannel: {
    id: string;
    label: string;
    linked: boolean;
    authAgeMs: number | null;
  } | null;
  heartbeat: {
    defaultAgentId: string;
    agents: Array<{
      agentId: string;
      enabled: boolean;
      every: string;
      everyMs: number | null;
    }>;
  };
  channelSummary: string[];
  queuedSystemEventsCount: number;
  sessions: {
    count: number;
    defaults: {
      model: string | null;
      contextTokens: number | null;
    };
    byAgent: Array<{
      agentId: string;
      count: number;
    }>;
  };
};

export type AcpxModelsCatalogProviderStatusPreview = {
  provider: string;
  totalModels: number;
  configured: boolean;
  reasoningModels: number;
  visionModels: number;
  sources: string[];
};

export type AcpxModelsCatalogStatusPreview = {
  bridge: {
    id: "acpx";
    mode: ResolvedAcpxMcpBridgeConfig["mode"];
    enabled: true;
  };
  source: "models.catalog.status";
  totalProviders: number;
  totalModels: number;
  configuredProviders: number;
  availableProviders: number;
  reasoningModels: number;
  visionModels: number;
  sourceCounts: Record<string, number>;
  providers: AcpxModelsCatalogProviderStatusPreview[];
};

export type AcpxUpdateStatusPreview = {
  bridge: {
    id: "acpx";
    mode: ResolvedAcpxMcpBridgeConfig["mode"];
    enabled: true;
  };
  source: "update.status";
  update: {
    installKind: string;
    packageManager: string;
    git?: {
      sha: string | null;
      tag: string | null;
      branch: string | null;
      upstream: string | null;
      dirty: boolean | null;
      ahead: number | null;
      behind: number | null;
      fetchOk: boolean | null;
      error?: string;
    };
    deps?: {
      manager: string;
      status: string;
      reason?: string;
    };
    registry?: {
      latestVersion: string | null;
      error?: string;
    };
  };
  availability: {
    available: boolean;
    hasGitUpdate: boolean;
    hasRegistryUpdate: boolean;
    latestVersion: string | null;
    gitBehind: number | null;
  };
  channel: {
    channel: string;
    source: string;
    label: string;
    config: string | null;
  };
  probes: {
    fetchGit: boolean;
    includeRegistry: boolean;
    timeoutMs: number;
  };
  summary: string;
};

export type AcpxCommandArgChoicePreview = {
  value: string;
  label: string;
};

export type AcpxCommandArgPreview = {
  name: string;
  description: string;
  type: string;
  required: boolean;
  dynamic: boolean;
  choices?: AcpxCommandArgChoicePreview[];
};

export type AcpxCommandEntryPreview = {
  name: string;
  nativeName?: string;
  textAliases?: string[];
  description: string;
  category?: string;
  source: string;
  scope: CommandScope;
  acceptsArgs: boolean;
  args?: AcpxCommandArgPreview[];
};

export type AcpxCommandsListPreview = {
  bridge: {
    id: "acpx";
    mode: ResolvedAcpxMcpBridgeConfig["mode"];
    enabled: true;
  };
  source: "commands.list";
  agentId: string;
  provider: string | null;
  scope: CommandScope;
  includeArgs: boolean;
  commands: AcpxCommandEntryPreview[];
};

export type AcpxAcpStatusPreview = {
  bridge: {
    id: "acpx";
    mode: ResolvedAcpxMcpBridgeConfig["mode"];
    enabled: true;
  };
  source: "acp.status";
  policy: {
    enabled: boolean;
    dispatchEnabled: boolean;
    backend: string;
    defaultAgent: string | null;
    allowedAgents: string[];
    maxConcurrentSessions: number | null;
  };
  runtimeBackend: {
    requestedId: string;
    registered: boolean;
    selectedId: string | null;
    healthy: boolean | null;
  };
  manager: {
    runtimeCache: {
      activeSessions: number;
      idleTtlMs: number;
      evictedTotal: number;
      lastEvictedAt?: number;
    };
    turns: {
      active: number;
      queueDepth: number;
      completed: number;
      failed: number;
      averageLatencyMs: number;
      maxLatencyMs: number;
    };
    errorsByCode: Record<string, number>;
  };
  sessions: {
    total: number;
    returned: number;
    limit: number;
    items: Array<{
      sessionKey: string;
      backend: string;
      agent: string;
      mode: AcpSessionMode;
      state: AcpSessionState;
      lastActivityAt: number;
      lastError?: string;
      identity?: {
        state: AcpIdentityState;
        source: AcpIdentitySource;
        acpxRecordId?: string;
        acpxSessionId?: string;
        agentSessionId?: string;
        lastUpdatedAt: number;
      };
      runtimeOptions: {
        runtimeMode?: string;
        model?: string;
        permissionProfile?: string;
        timeoutSeconds?: number;
        backendExtrasKeys?: string[];
        cwdConfigured: boolean;
      };
    }>;
  };
};

export type AcpxMcpEffectiveToolsPreviewResolver = (params: {
  context: FasedAgentPluginServiceContext;
  agentId?: string;
}) => Promise<RawEffectiveToolInventoryResult> | RawEffectiveToolInventoryResult;

export type AcpxMcpGatewayIdentityResolver = (params: {
  context: FasedAgentPluginServiceContext;
}) => Promise<RawPublicGatewayIdentity> | RawPublicGatewayIdentity;

export type AcpxMcpGatewayStatusResolver = (params: {
  context: FasedAgentPluginServiceContext;
}) => Promise<RawGatewayStatusResult> | RawGatewayStatusResult;

export type AcpxMcpModelsCatalogStatusResolver = (params: {
  context: FasedAgentPluginServiceContext;
}) => Promise<RawModelsCatalogStatusResult> | RawModelsCatalogStatusResult;

export type AcpxMcpUpdateStatusResolver = (params: {
  context: FasedAgentPluginServiceContext;
}) => Promise<RawUpdateStatusResult> | RawUpdateStatusResult;

export type AcpxMcpCommandsListResolver = (params: {
  context: FasedAgentPluginServiceContext;
  agentId?: string;
  provider?: string;
  scope: CommandScope;
  includeArgs: boolean;
}) => Promise<RawCommandsListResult> | RawCommandsListResult;

export type AcpxMcpAcpStatusResolver = (params: {
  context: FasedAgentPluginServiceContext;
  limit: number;
}) => Promise<RawAcpStatusResult> | RawAcpStatusResult;

export type CreateAcpxMcpStatusServerParams = {
  bridgeConfig: ResolvedAcpxMcpBridgeConfig;
  context: FasedAgentPluginServiceContext;
  logger?: PluginLogger;
  effectiveToolsPreviewResolver?: AcpxMcpEffectiveToolsPreviewResolver;
  gatewayIdentityResolver?: AcpxMcpGatewayIdentityResolver;
  gatewayStatusResolver?: AcpxMcpGatewayStatusResolver;
  modelsCatalogStatusResolver?: AcpxMcpModelsCatalogStatusResolver;
  updateStatusResolver?: AcpxMcpUpdateStatusResolver;
  commandsListResolver?: AcpxMcpCommandsListResolver;
  acpStatusResolver?: AcpxMcpAcpStatusResolver;
  pushTestExecutionAdapter?: AcpxPushTestMcpToolExecutionAdapter;
};

export type AcpxMcpStatusServer = {
  server: McpServer;
  toolNames: string[];
  startEndpoint(): Promise<AcpxMcpStatusEndpoint>;
  getEndpoint(): AcpxMcpStatusEndpoint | null;
  previewEffectiveTools(input?: { agentId?: string }): Promise<AcpxToolsEffectivePreview>;
  previewGatewayStatus(): Promise<AcpxGatewayStatusPreview>;
  previewModelsCatalogStatus(): Promise<AcpxModelsCatalogStatusPreview>;
  previewUpdateStatus(): Promise<AcpxUpdateStatusPreview>;
  previewCommandsList(input?: {
    agentId?: string;
    provider?: string;
    scope?: CommandScope;
    includeArgs?: boolean;
  }): Promise<AcpxCommandsListPreview>;
  previewAcpStatus(input?: { limit?: number }): Promise<AcpxAcpStatusPreview>;
  executePushTestRequest(
    request: AcpxPushTestApprovalContractRequest,
  ): Promise<AcpxPushTestExecutionAdapterResult>;
  close(): Promise<void>;
  isClosed(): boolean;
};

export type AcpxMcpStatusEndpoint = {
  url: string;
  token: string;
  toolNames: string[];
  mode?: ResolvedAcpxMcpBridgeConfig["mode"];
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function createCapabilityToken(): string {
  return randomBytes(32).toString("base64url");
}

function isAuthorizedRequest(params: { authorization?: string; token: string }): boolean {
  return params.authorization === `Bearer ${params.token}`;
}

async function listen(server: Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("ACPX MCP status endpoint did not bind to a TCP address"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function defaultEffectiveToolsPreviewResolver(params: {
  context: FasedAgentPluginServiceContext;
  agentId?: string;
}): Promise<RawEffectiveToolInventoryResult> {
  const { resolveEffectiveToolInventory } =
    await import("../../../src/agents/tools-effective-inventory.js");
  return resolveEffectiveToolInventory({
    cfg: params.context.config,
    agentId: params.agentId,
    workspaceDir: params.context.workspaceDir,
  });
}

async function defaultGatewayIdentityResolver(): Promise<RawPublicGatewayIdentity> {
  const { getPublicGatewayIdentity } = await import("../../../src/gateway/gateway-identity.js");
  return getPublicGatewayIdentity();
}

async function defaultGatewayStatusResolver(): Promise<RawGatewayStatusResult> {
  const { getStatusSummary } = await import("../../../src/commands/status.js");
  return getStatusSummary({
    includeSensitive: false,
  });
}

async function defaultModelsCatalogStatusResolver(): Promise<RawModelsCatalogStatusResult> {
  const [{ loadConfig }, { loadGatewayModelCatalog }, { buildModelCatalogStatus }] =
    await Promise.all([
      import("../../../src/config/config.js"),
      import("../../../src/gateway/server-model-catalog.js"),
      import("../../../src/agents/model-catalog-status.js"),
    ]);
  const catalog = await loadGatewayModelCatalog();
  return buildModelCatalogStatus({
    catalog,
    cfg: loadConfig(),
  });
}

async function defaultUpdateStatusResolver(): Promise<RawUpdateStatusResult> {
  const { getGatewayUpdateStatus } = await import("../../../src/gateway/update-status.js");
  return getGatewayUpdateStatus({
    fetchGit: false,
    includeRegistry: false,
  });
}

async function defaultCommandsListResolver(params: {
  context: FasedAgentPluginServiceContext;
  agentId?: string;
  provider?: string;
  scope: CommandScope;
  includeArgs: boolean;
}): Promise<RawCommandsListResult> {
  const [{ listAgentIds, resolveDefaultAgentId }, { buildCommandsListResult }] = await Promise.all([
    import("../../../src/agents/agent-scope.js"),
    import("../../../src/gateway/server-methods/commands.js"),
  ]);
  const cfg = params.context.config;
  const requestedAgentId = normalizeOptionalString(params.agentId);
  const agentId = requestedAgentId ?? resolveDefaultAgentId(cfg);
  if (requestedAgentId && !listAgentIds(cfg).includes(agentId)) {
    throw new Error(`unknown agent id "${requestedAgentId}"`);
  }
  return buildCommandsListResult({
    cfg,
    agentId,
    provider: params.provider,
    scope: params.scope,
    includeArgs: params.includeArgs,
  });
}

async function defaultAcpStatusResolver(params: {
  context: FasedAgentPluginServiceContext;
  limit: number;
}): Promise<RawAcpStatusResult> {
  const { getAcpStatusSnapshot } = await import("../../../src/acp/status-snapshot.js");
  return getAcpStatusSnapshot({
    cfg: params.context.config,
    limit: params.limit,
  });
}

function createAcpxMcpGatewayClient(): GatewayClient {
  return {
    connId: "acpx-mcp-bridge",
    clientIp: "127.0.0.1",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "acpx-mcp-bridge",
        version: "0.1.0",
        platform: "local",
        mode: "dashboard",
      },
      role: "operator",
      scopes: ["operator.write"],
      device: {
        id: "acpx-mcp-bridge",
      },
    },
  } as unknown as GatewayClient;
}

function createAcpxMcpGatewayContext(params: {
  context: FasedAgentPluginServiceContext;
  logger?: PluginLogger;
}): GatewayRequestContext {
  const logger = params.logger ?? params.context.logger;
  return {
    logGateway: {
      info: (message: string) => logger.info(message),
      warn: (message: string) => logger.warn(message),
      error: (message: string) => logger.error(message),
      debug: (message: string) => logger.debug?.(message),
    },
  } as GatewayRequestContext;
}

async function defaultPushTestExecutionAdapter(params: {
  request: AcpxPushTestApprovalContractRequest;
  context: FasedAgentPluginServiceContext;
  logger?: PluginLogger;
}): Promise<AcpxPushTestExecutionAdapterResult> {
  const { pushHandlers } = await import("../../../src/gateway/server-methods/push.js");
  const handler = pushHandlers[ACPX_PUSH_TEST_METHOD];
  return executeAcpxPushTestRequest({
    request: params.request,
    executionGate: {
      enabled: true,
      allowExecution: true,
      gatewayHandlerRegistered: typeof handler === "function",
    },
    handler,
    context: createAcpxMcpGatewayContext({
      context: params.context,
      logger: params.logger,
    }),
    client: createAcpxMcpGatewayClient(),
  });
}

function sanitizeToolEntry(entry: RawEffectiveToolEntry): AcpxEffectiveToolPreviewEntry | null {
  const id = normalizeOptionalString(entry.id);
  if (!id) {
    return null;
  }
  return {
    id,
    label: normalizeOptionalString(entry.label) ?? id,
    description: normalizeOptionalString(entry.description) ?? "",
    source: normalizeOptionalString(entry.source) ?? "unknown",
    pluginId: normalizeOptionalString(entry.pluginId),
    channelId: normalizeOptionalString(entry.channelId),
  };
}

function sanitizeToolGroups(value: unknown): AcpxEffectiveToolPreviewGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const groups: AcpxEffectiveToolPreviewGroup[] = [];
  for (const rawGroup of value) {
    if (!rawGroup || typeof rawGroup !== "object") {
      continue;
    }
    const group = rawGroup as RawEffectiveToolGroup;
    const id = normalizeOptionalString(group.id);
    if (!id) {
      continue;
    }
    const tools = Array.isArray(group.tools)
      ? group.tools
          .map((tool) =>
            tool && typeof tool === "object"
              ? sanitizeToolEntry(tool as RawEffectiveToolEntry)
              : null,
          )
          .filter((tool): tool is AcpxEffectiveToolPreviewEntry => tool !== null)
      : [];
    groups.push({
      id,
      label: normalizeOptionalString(group.label) ?? id,
      source: normalizeOptionalString(group.source) ?? id,
      tools,
    });
  }
  return groups;
}

function sanitizePreviewResult(
  result: RawEffectiveToolInventoryResult,
  bridgeMode: ResolvedAcpxMcpBridgeConfig["mode"],
  fallbackAgentId?: string,
): AcpxToolsEffectivePreview {
  return {
    bridge: {
      id: "acpx",
      mode: bridgeMode,
      enabled: true,
    },
    agentId: normalizeOptionalString(result.agentId) ?? fallbackAgentId ?? "main",
    profile: normalizeOptionalString(result.profile) ?? "unknown",
    groups: sanitizeToolGroups(result.groups),
  };
}

function sanitizeGatewayIdentityResult(
  result: RawPublicGatewayIdentity,
  bridgeMode: ResolvedAcpxMcpBridgeConfig["mode"],
): AcpxGatewayIdentityPreview {
  const deviceId = normalizeOptionalString(result.deviceId);
  const publicKey = normalizeOptionalString(result.publicKey);
  if (!deviceId || !publicKey) {
    throw new Error("gateway identity resolver returned an invalid public identity");
  }
  return {
    bridge: {
      id: "acpx",
      mode: bridgeMode,
      enabled: true,
    },
    source: "gateway.identity.get",
    gateway: {
      deviceId,
      publicKey,
    },
  };
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeNullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function normalizeAcpStatusLimit(value: unknown): number {
  const normalized = normalizeNonNegativeInteger(value, 20);
  return Math.max(0, Math.min(100, normalized));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeCommandScope(value: unknown): CommandScope {
  return value === "native" || value === "text" || value === "both" ? value : "both";
}

function normalizeAcpSessionMode(value: unknown): AcpSessionMode {
  return value === "oneshot" ? "oneshot" : "persistent";
}

function normalizeAcpSessionState(value: unknown): AcpSessionState {
  return value === "running" || value === "error" || value === "idle" ? value : "idle";
}

function normalizeAcpIdentityState(value: unknown): AcpIdentityState {
  return value === "resolved" ? "resolved" : "pending";
}

function normalizeAcpIdentitySource(value: unknown): AcpIdentitySource {
  return value === "status" || value === "event" || value === "ensure" ? value : "ensure";
}

function sanitizeUpdateStatusResult(
  result: RawUpdateStatusResult,
  bridgeMode: ResolvedAcpxMcpBridgeConfig["mode"],
): AcpxUpdateStatusPreview {
  const update = asRecord(result.update) as RawUpdateStatusUpdate;
  const git = asRecord(update.git) as RawUpdateStatusGit;
  const deps = asRecord(update.deps) as RawUpdateStatusDeps;
  const registry = asRecord(update.registry) as RawUpdateStatusRegistry;
  const availability = asRecord(result.availability) as RawUpdateAvailability;
  const channel = asRecord(result.channel) as RawUpdateChannel;
  const probes = asRecord(result.probes) as RawUpdateProbes;
  const gitPresent = Object.keys(git).length > 0;
  const depsPresent = Object.keys(deps).length > 0;
  const registryPresent = Object.keys(registry).length > 0;
  const latestVersion = normalizeNullableString(availability.latestVersion);

  return {
    bridge: {
      id: "acpx",
      mode: bridgeMode,
      enabled: true,
    },
    source: "update.status",
    update: {
      installKind: normalizeOptionalString(update.installKind) ?? "unknown",
      packageManager: normalizeOptionalString(update.packageManager) ?? "unknown",
      ...(gitPresent
        ? {
            git: {
              sha: normalizeNullableString(git.sha)?.slice(0, 12) ?? null,
              tag: normalizeNullableString(git.tag),
              branch: normalizeNullableString(git.branch),
              upstream: normalizeNullableString(git.upstream),
              dirty: normalizeNullableBoolean(git.dirty),
              ahead: normalizeNullableNumber(git.ahead),
              behind: normalizeNullableNumber(git.behind),
              fetchOk: normalizeNullableBoolean(git.fetchOk),
              ...(normalizeNullableString(git.error)
                ? { error: normalizeNullableString(git.error) ?? undefined }
                : {}),
            },
          }
        : {}),
      ...(depsPresent
        ? {
            deps: {
              manager: normalizeOptionalString(deps.manager) ?? "unknown",
              status: normalizeOptionalString(deps.status) ?? "unknown",
              ...(normalizeNullableString(deps.reason)
                ? { reason: normalizeNullableString(deps.reason) ?? undefined }
                : {}),
            },
          }
        : {}),
      ...(registryPresent
        ? {
            registry: {
              latestVersion: normalizeNullableString(registry.latestVersion),
              ...(normalizeNullableString(registry.error)
                ? { error: normalizeNullableString(registry.error) ?? undefined }
                : {}),
            },
          }
        : {}),
    },
    availability: {
      available: normalizeBoolean(availability.available),
      hasGitUpdate: normalizeBoolean(availability.hasGitUpdate),
      hasRegistryUpdate: normalizeBoolean(availability.hasRegistryUpdate),
      latestVersion,
      gitBehind: normalizeNullableNumber(availability.gitBehind),
    },
    channel: {
      channel: normalizeOptionalString(channel.channel) ?? "stable",
      source: normalizeOptionalString(channel.source) ?? "default",
      label: normalizeOptionalString(channel.label) ?? "stable (default)",
      config: normalizeNullableString(channel.config),
    },
    probes: {
      fetchGit: normalizeBoolean(probes.fetchGit),
      includeRegistry: normalizeBoolean(probes.includeRegistry),
      timeoutMs: normalizePositiveNumber(probes.timeoutMs, 3500),
    },
    summary: normalizeOptionalString(result.summary) ?? "Update: unknown",
  };
}

function sanitizeGatewayStartupStatus(value: unknown): AcpxGatewayStatusPreview["gatewayStartup"] {
  if (!value || typeof value !== "object") {
    return null;
  }
  const startup = value as RawGatewayStartupStatus;
  const entries = Array.isArray(startup.entries)
    ? startup.entries
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const rawEntry = entry as RawGatewayStartupStatusEntry;
          const name = normalizeOptionalString(rawEntry.name);
          if (!name) {
            return null;
          }
          return {
            name,
            durationMs: normalizeNonNegativeInteger(rawEntry.durationMs, 0),
          };
        })
        .filter((entry): entry is { name: string; durationMs: number } => entry !== null)
    : [];
  return {
    entries,
    totalMs: normalizeNullableNumber(startup.totalMs),
    summary: normalizeNullableString(startup.summary),
    recordedAtMs: normalizeNullableNumber(startup.recordedAtMs),
  };
}

function sanitizeGatewayLinkChannelStatus(value: unknown): AcpxGatewayStatusPreview["linkChannel"] {
  if (!value || typeof value !== "object") {
    return null;
  }
  const link = value as RawGatewayLinkChannelStatus;
  const id = normalizeOptionalString(link.id);
  if (!id) {
    return null;
  }
  return {
    id,
    label: normalizeOptionalString(link.label) ?? id,
    linked: normalizeBoolean(link.linked),
    authAgeMs: normalizeNullableNumber(link.authAgeMs),
  };
}

function sanitizeGatewayHeartbeatStatus(value: unknown): AcpxGatewayStatusPreview["heartbeat"] {
  const heartbeat = asRecord(value) as RawGatewayHeartbeatStatus;
  const agents = Array.isArray(heartbeat.agents)
    ? heartbeat.agents
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const agent = entry as RawGatewayHeartbeatAgentStatus;
          const agentId = normalizeOptionalString(agent.agentId);
          if (!agentId) {
            return null;
          }
          return {
            agentId,
            enabled: normalizeBoolean(agent.enabled),
            every: normalizeOptionalString(agent.every) ?? "",
            everyMs: normalizeNullableNumber(agent.everyMs),
          };
        })
        .filter(
          (agent): agent is AcpxGatewayStatusPreview["heartbeat"]["agents"][number] =>
            agent !== null,
        )
    : [];
  return {
    defaultAgentId: normalizeOptionalString(heartbeat.defaultAgentId) ?? "main",
    agents,
  };
}

function sanitizeGatewaySessionsStatus(value: unknown): AcpxGatewayStatusPreview["sessions"] {
  const sessions = asRecord(value) as RawGatewaySessionsStatus;
  const defaults = asRecord(sessions.defaults) as RawGatewaySessionDefaultsStatus;
  const byAgent = Array.isArray(sessions.byAgent)
    ? sessions.byAgent
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const agent = entry as RawGatewaySessionAgentStatus;
          const agentId = normalizeOptionalString(agent.agentId);
          if (!agentId) {
            return null;
          }
          return {
            agentId,
            count: normalizeNonNegativeInteger(agent.count, 0),
          };
        })
        .filter(
          (agent): agent is AcpxGatewayStatusPreview["sessions"]["byAgent"][number] =>
            agent !== null,
        )
    : [];
  return {
    count: normalizeNonNegativeInteger(
      sessions.count,
      byAgent.reduce((sum, agent) => sum + agent.count, 0),
    ),
    defaults: {
      model: normalizeNullableString(defaults.model),
      contextTokens: normalizeNullableNumber(defaults.contextTokens),
    },
    byAgent,
  };
}

function sanitizeGatewayStatusResult(
  result: RawGatewayStatusResult,
  bridgeMode: ResolvedAcpxMcpBridgeConfig["mode"],
): AcpxGatewayStatusPreview {
  return {
    bridge: {
      id: "acpx",
      mode: bridgeMode,
      enabled: true,
    },
    source: "status",
    gatewayStartup: sanitizeGatewayStartupStatus(result.gatewayStartup),
    linkChannel: sanitizeGatewayLinkChannelStatus(result.linkChannel),
    heartbeat: sanitizeGatewayHeartbeatStatus(result.heartbeat),
    channelSummary: Array.isArray(result.channelSummary)
      ? result.channelSummary
          .map(normalizeOptionalString)
          .filter((line): line is string => line != null)
      : [],
    queuedSystemEventsCount: normalizeArrayLength(result.queuedSystemEvents),
    sessions: sanitizeGatewaySessionsStatus(result.sessions),
  };
}

function sanitizeNonNegativeNumberRecord(value: unknown): Record<string, number> {
  const record = asRecord(value);
  const output: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    const source = normalizeOptionalString(key);
    if (!source || typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
      continue;
    }
    output[source] = Math.floor(entry);
  }
  return output;
}

function sanitizeModelsCatalogProviderStatus(
  value: unknown,
): AcpxModelsCatalogProviderStatusPreview | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const provider = value as RawModelsCatalogProviderStatus;
  const providerId = normalizeOptionalString(provider.provider);
  if (!providerId) {
    return null;
  }
  const sources = Array.isArray(provider.sources)
    ? provider.sources
        .map(normalizeOptionalString)
        .filter((source): source is string => source != null)
        .toSorted((left, right) => left.localeCompare(right))
    : [];
  return {
    provider: providerId,
    totalModels: normalizeNonNegativeInteger(provider.totalModels, 0),
    configured: normalizeBoolean(provider.configured),
    reasoningModels: normalizeNonNegativeInteger(provider.reasoningModels, 0),
    visionModels: normalizeNonNegativeInteger(provider.visionModels, 0),
    sources,
  };
}

function sanitizeModelsCatalogStatusResult(
  result: RawModelsCatalogStatusResult,
  bridgeMode: ResolvedAcpxMcpBridgeConfig["mode"],
): AcpxModelsCatalogStatusPreview {
  const providers = Array.isArray(result.providers)
    ? result.providers
        .map(sanitizeModelsCatalogProviderStatus)
        .filter((provider): provider is AcpxModelsCatalogProviderStatusPreview => provider !== null)
    : [];
  const configuredFallback = providers.filter((provider) => provider.configured).length;
  return {
    bridge: {
      id: "acpx",
      mode: bridgeMode,
      enabled: true,
    },
    source: "models.catalog.status",
    totalProviders: normalizeNonNegativeInteger(result.totalProviders, providers.length),
    totalModels: normalizeNonNegativeInteger(
      result.totalModels,
      providers.reduce((sum, provider) => sum + provider.totalModels, 0),
    ),
    configuredProviders: normalizeNonNegativeInteger(
      result.configuredProviders,
      configuredFallback,
    ),
    availableProviders: normalizeNonNegativeInteger(
      result.availableProviders,
      Math.max(0, providers.length - configuredFallback),
    ),
    reasoningModels: normalizeNonNegativeInteger(result.reasoningModels, 0),
    visionModels: normalizeNonNegativeInteger(result.visionModels, 0),
    sourceCounts: sanitizeNonNegativeNumberRecord(result.sourceCounts),
    providers,
  };
}

function sanitizeNumberRecord(value: unknown): Record<string, number> {
  const record = asRecord(value);
  const output: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      output[key] = entry;
    }
  }
  return output;
}

function sanitizeAcpRuntimeOptions(
  value: unknown,
): AcpxAcpStatusPreview["sessions"]["items"][number]["runtimeOptions"] {
  const runtimeOptions = asRecord(value) as RawAcpStatusRuntimeOptions;
  const backendExtrasKeys = Array.isArray(runtimeOptions.backendExtrasKeys)
    ? runtimeOptions.backendExtrasKeys
        .map(normalizeOptionalString)
        .filter((key): key is string => key != null)
        .toSorted()
    : [];
  return {
    ...(normalizeOptionalString(runtimeOptions.runtimeMode)
      ? { runtimeMode: normalizeOptionalString(runtimeOptions.runtimeMode) ?? undefined }
      : {}),
    ...(normalizeOptionalString(runtimeOptions.model)
      ? { model: normalizeOptionalString(runtimeOptions.model) ?? undefined }
      : {}),
    ...(normalizeOptionalString(runtimeOptions.permissionProfile)
      ? {
          permissionProfile: normalizeOptionalString(runtimeOptions.permissionProfile) ?? undefined,
        }
      : {}),
    ...(normalizeNullableNumber(runtimeOptions.timeoutSeconds) != null
      ? { timeoutSeconds: normalizeNullableNumber(runtimeOptions.timeoutSeconds) ?? undefined }
      : {}),
    ...(backendExtrasKeys.length > 0 ? { backendExtrasKeys } : {}),
    cwdConfigured: normalizeBoolean(runtimeOptions.cwdConfigured),
  };
}

function sanitizeAcpIdentity(
  value: unknown,
): NonNullable<AcpxAcpStatusPreview["sessions"]["items"][number]["identity"]> | undefined {
  const identity = asRecord(value) as RawAcpStatusIdentity;
  if (Object.keys(identity).length === 0) {
    return undefined;
  }
  return {
    state: normalizeAcpIdentityState(identity.state),
    source: normalizeAcpIdentitySource(identity.source),
    ...(normalizeOptionalString(identity.acpxRecordId)
      ? { acpxRecordId: normalizeOptionalString(identity.acpxRecordId) ?? undefined }
      : {}),
    ...(normalizeOptionalString(identity.acpxSessionId)
      ? { acpxSessionId: normalizeOptionalString(identity.acpxSessionId) ?? undefined }
      : {}),
    ...(normalizeOptionalString(identity.agentSessionId)
      ? { agentSessionId: normalizeOptionalString(identity.agentSessionId) ?? undefined }
      : {}),
    lastUpdatedAt: normalizeNonNegativeInteger(identity.lastUpdatedAt, 0),
  };
}

function sanitizeAcpSession(
  value: unknown,
): AcpxAcpStatusPreview["sessions"]["items"][number] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const session = value as RawAcpStatusSession;
  const sessionKey = normalizeOptionalString(session.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const identity = sanitizeAcpIdentity(session.identity);
  return {
    sessionKey,
    backend: normalizeOptionalString(session.backend) ?? "unknown",
    agent: normalizeOptionalString(session.agent) ?? "unknown",
    mode: normalizeAcpSessionMode(session.mode),
    state: normalizeAcpSessionState(session.state),
    lastActivityAt: normalizeNonNegativeInteger(session.lastActivityAt, 0),
    ...(normalizeOptionalString(session.lastError)
      ? { lastError: normalizeOptionalString(session.lastError) ?? undefined }
      : {}),
    ...(identity ? { identity } : {}),
    runtimeOptions: sanitizeAcpRuntimeOptions(session.runtimeOptions),
  };
}

function sanitizeAcpStatusResult(
  result: RawAcpStatusResult,
  bridgeMode: ResolvedAcpxMcpBridgeConfig["mode"],
  fallbackLimit: number,
): AcpxAcpStatusPreview {
  const policy = asRecord(result.policy) as RawAcpStatusPolicy;
  const runtimeBackend = asRecord(result.runtimeBackend) as RawAcpStatusRuntimeBackend;
  const manager = asRecord(result.manager) as RawAcpStatusManager;
  const runtimeCache = asRecord(manager.runtimeCache) as RawAcpStatusRuntimeCache;
  const turns = asRecord(manager.turns) as RawAcpStatusTurns;
  const sessions = asRecord(result.sessions) as RawAcpStatusSessions;
  const items = Array.isArray(sessions.items)
    ? sessions.items
        .map(sanitizeAcpSession)
        .filter(
          (session): session is AcpxAcpStatusPreview["sessions"]["items"][number] =>
            session !== null,
        )
    : [];
  const allowedAgents = Array.isArray(policy.allowedAgents)
    ? policy.allowedAgents
        .map(normalizeOptionalString)
        .filter((agent): agent is string => agent != null)
        .toSorted()
    : [];

  return {
    bridge: {
      id: "acpx",
      mode: bridgeMode,
      enabled: true,
    },
    source: "acp.status",
    policy: {
      enabled: policy.enabled !== false,
      dispatchEnabled: normalizeBoolean(policy.dispatchEnabled),
      backend: normalizeOptionalString(policy.backend) ?? "acpx",
      defaultAgent: normalizeNullableString(policy.defaultAgent),
      allowedAgents,
      maxConcurrentSessions: normalizeNullableNumber(policy.maxConcurrentSessions),
    },
    runtimeBackend: {
      requestedId: normalizeOptionalString(runtimeBackend.requestedId) ?? "acpx",
      registered: normalizeBoolean(runtimeBackend.registered),
      selectedId: normalizeNullableString(runtimeBackend.selectedId),
      healthy: typeof runtimeBackend.healthy === "boolean" ? runtimeBackend.healthy : null,
    },
    manager: {
      runtimeCache: {
        activeSessions: normalizeNonNegativeInteger(runtimeCache.activeSessions, 0),
        idleTtlMs: normalizeNonNegativeInteger(runtimeCache.idleTtlMs, 0),
        evictedTotal: normalizeNonNegativeInteger(runtimeCache.evictedTotal, 0),
        ...(normalizeNullableNumber(runtimeCache.lastEvictedAt) != null
          ? { lastEvictedAt: normalizeNullableNumber(runtimeCache.lastEvictedAt) ?? undefined }
          : {}),
      },
      turns: {
        active: normalizeNonNegativeInteger(turns.active, 0),
        queueDepth: normalizeNonNegativeInteger(turns.queueDepth, 0),
        completed: normalizeNonNegativeInteger(turns.completed, 0),
        failed: normalizeNonNegativeInteger(turns.failed, 0),
        averageLatencyMs: normalizeNonNegativeInteger(turns.averageLatencyMs, 0),
        maxLatencyMs: normalizeNonNegativeInteger(turns.maxLatencyMs, 0),
      },
      errorsByCode: sanitizeNumberRecord(manager.errorsByCode),
    },
    sessions: {
      total: normalizeNonNegativeInteger(sessions.total, items.length),
      returned: normalizeNonNegativeInteger(sessions.returned, items.length),
      limit: normalizeNonNegativeInteger(sessions.limit, fallbackLimit),
      items,
    },
  };
}

function sanitizeCommandArgChoice(value: unknown): AcpxCommandArgChoicePreview | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const choice = value as RawCommandArgChoice;
  const choiceValue = normalizeOptionalString(choice.value);
  if (!choiceValue) {
    return null;
  }
  return {
    value: choiceValue,
    label: normalizeOptionalString(choice.label) ?? choiceValue,
  };
}

function sanitizeCommandArg(value: unknown): AcpxCommandArgPreview | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const arg = value as RawCommandArg;
  const name = normalizeOptionalString(arg.name);
  if (!name) {
    return null;
  }
  const choices = Array.isArray(arg.choices)
    ? arg.choices
        .map(sanitizeCommandArgChoice)
        .filter((choice): choice is AcpxCommandArgChoicePreview => choice !== null)
    : [];
  return {
    name,
    description: normalizeOptionalString(arg.description) ?? "",
    type: normalizeOptionalString(arg.type) ?? "string",
    required: normalizeBoolean(arg.required),
    dynamic: normalizeBoolean(arg.dynamic),
    ...(choices.length > 0 ? { choices } : {}),
  };
}

function sanitizeCommandEntry(value: unknown): AcpxCommandEntryPreview | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const command = value as RawCommandEntry;
  const name = normalizeOptionalString(command.name);
  if (!name) {
    return null;
  }
  const textAliases = Array.isArray(command.textAliases)
    ? command.textAliases
        .map(normalizeOptionalString)
        .filter((alias): alias is string => alias != null)
    : [];
  const args = Array.isArray(command.args)
    ? command.args
        .map(sanitizeCommandArg)
        .filter((arg): arg is AcpxCommandArgPreview => arg !== null)
    : [];
  return {
    name,
    ...(normalizeOptionalString(command.nativeName)
      ? { nativeName: normalizeOptionalString(command.nativeName) ?? undefined }
      : {}),
    ...(textAliases.length > 0 ? { textAliases } : {}),
    description: normalizeOptionalString(command.description) ?? "",
    ...(normalizeOptionalString(command.category)
      ? { category: normalizeOptionalString(command.category) ?? undefined }
      : {}),
    source: normalizeOptionalString(command.source) ?? "unknown",
    scope: normalizeCommandScope(command.scope),
    acceptsArgs: normalizeBoolean(command.acceptsArgs),
    ...(args.length > 0 ? { args } : {}),
  };
}

function sanitizeCommandsListResult(
  result: RawCommandsListResult,
  bridgeMode: ResolvedAcpxMcpBridgeConfig["mode"],
  filters: {
    agentId: string;
    provider?: string;
    scope: CommandScope;
    includeArgs: boolean;
  },
): AcpxCommandsListPreview {
  const commands = Array.isArray(result.commands)
    ? result.commands
        .map(sanitizeCommandEntry)
        .filter((command): command is AcpxCommandEntryPreview => command !== null)
    : [];
  return {
    bridge: {
      id: "acpx",
      mode: bridgeMode,
      enabled: true,
    },
    source: "commands.list",
    agentId: filters.agentId,
    provider: filters.provider ?? null,
    scope: filters.scope,
    includeArgs: filters.includeArgs,
    commands,
  };
}

export function createAcpxMcpStatusServer(
  params: CreateAcpxMcpStatusServerParams,
): AcpxMcpStatusServer {
  if (!params.bridgeConfig.enabled) {
    throw new Error("ACPX MCP status server requires mcpBridge.enabled=true");
  }
  if (
    params.bridgeConfig.mode !== "status-only" &&
    params.bridgeConfig.mode !== "read-only-tools" &&
    params.bridgeConfig.mode !== "operator-approved-mutating-tools"
  ) {
    throw new Error(`unsupported ACPX MCP bridge mode: ${String(params.bridgeConfig.mode)}`);
  }
  const implementedBridgeTools = resolveAcpxMcpBridgeToolDefinitions(params.bridgeConfig, {
    implementedOnly: true,
  });
  const implementedMutatingBridgeTools = resolveAcpxMcpMutatingToolDefinitions(params.bridgeConfig);

  const toolNames: string[] = [];
  let endpoint: AcpxMcpStatusEndpoint | null = null;
  let httpServer: Server | null = null;
  const activeRequestServers = new Set<McpServer>();
  const activeRequestTransports = new Set<StreamableHTTPServerTransport>();
  let closed = false;

  const previewResolver =
    params.effectiveToolsPreviewResolver ?? defaultEffectiveToolsPreviewResolver;
  const gatewayIdentityResolver = params.gatewayIdentityResolver ?? defaultGatewayIdentityResolver;
  const gatewayStatusResolver = params.gatewayStatusResolver ?? defaultGatewayStatusResolver;
  const modelsCatalogStatusResolver =
    params.modelsCatalogStatusResolver ?? defaultModelsCatalogStatusResolver;
  const updateStatusResolver = params.updateStatusResolver ?? defaultUpdateStatusResolver;
  const commandsListResolver = params.commandsListResolver ?? defaultCommandsListResolver;
  const acpStatusResolver = params.acpStatusResolver ?? defaultAcpStatusResolver;
  const pushTestExecutionAdapter =
    params.pushTestExecutionAdapter ??
    ((input: { request: AcpxPushTestApprovalContractRequest }) =>
      defaultPushTestExecutionAdapter({
        ...input,
        context: params.context,
        logger: params.logger,
      }));
  const previewEffectiveTools = async (input?: {
    agentId?: string;
  }): Promise<AcpxToolsEffectivePreview> => {
    if (closed) {
      throw new Error("ACPX MCP status server is closed");
    }
    const agentId = normalizeOptionalString(input?.agentId);
    const preview = await previewResolver({
      context: params.context,
      agentId,
    });
    return sanitizePreviewResult(preview, params.bridgeConfig.mode, agentId);
  };
  const previewGatewayIdentity = async (): Promise<AcpxGatewayIdentityPreview> => {
    if (closed) {
      throw new Error("ACPX MCP status server is closed");
    }
    const identity = await gatewayIdentityResolver({
      context: params.context,
    });
    return sanitizeGatewayIdentityResult(identity, params.bridgeConfig.mode);
  };
  const previewGatewayStatus = async (): Promise<AcpxGatewayStatusPreview> => {
    if (closed) {
      throw new Error("ACPX MCP status server is closed");
    }
    const status = await gatewayStatusResolver({
      context: params.context,
    });
    return sanitizeGatewayStatusResult(status, params.bridgeConfig.mode);
  };
  const previewModelsCatalogStatus = async (): Promise<AcpxModelsCatalogStatusPreview> => {
    if (closed) {
      throw new Error("ACPX MCP status server is closed");
    }
    const status = await modelsCatalogStatusResolver({
      context: params.context,
    });
    return sanitizeModelsCatalogStatusResult(status, params.bridgeConfig.mode);
  };
  const previewUpdateStatus = async (): Promise<AcpxUpdateStatusPreview> => {
    if (closed) {
      throw new Error("ACPX MCP status server is closed");
    }
    const status = await updateStatusResolver({
      context: params.context,
    });
    return sanitizeUpdateStatusResult(status, params.bridgeConfig.mode);
  };
  const previewCommandsList = async (input?: {
    agentId?: string;
    provider?: string;
    scope?: CommandScope;
    includeArgs?: boolean;
  }): Promise<AcpxCommandsListPreview> => {
    if (closed) {
      throw new Error("ACPX MCP status server is closed");
    }
    const agentId = normalizeOptionalString(input?.agentId) ?? "main";
    const provider = normalizeOptionalString(input?.provider);
    const scope = normalizeCommandScope(input?.scope);
    const includeArgs = input?.includeArgs !== false;
    const commands = await commandsListResolver({
      context: params.context,
      agentId,
      provider,
      scope,
      includeArgs,
    });
    return sanitizeCommandsListResult(commands, params.bridgeConfig.mode, {
      agentId,
      provider,
      scope,
      includeArgs,
    });
  };
  const previewAcpStatus = async (input?: { limit?: number }): Promise<AcpxAcpStatusPreview> => {
    if (closed) {
      throw new Error("ACPX MCP status server is closed");
    }
    const limit = normalizeAcpStatusLimit(input?.limit);
    const status = await acpStatusResolver({
      context: params.context,
      limit,
    });
    return sanitizeAcpStatusResult(status, params.bridgeConfig.mode, limit);
  };
  const executePushTestRequest = async (
    request: AcpxPushTestApprovalContractRequest,
  ): Promise<AcpxPushTestExecutionAdapterResult> => {
    if (closed) {
      throw new Error("ACPX MCP status server is closed");
    }
    if (
      !implementedMutatingBridgeTools.some(
        (toolDefinition) => toolDefinition.id === ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME,
      )
    ) {
      throw new Error("ACPX push-test MCP tool is not enabled");
    }
    return pushTestExecutionAdapter({ request });
  };

  const hasImplementedBridgeTool = (toolName: string) =>
    implementedBridgeTools.some((toolDefinition) => toolDefinition.id === toolName);
  const hasImplementedMutatingBridgeTool = (toolName: string) =>
    implementedMutatingBridgeTools.some((toolDefinition) => toolDefinition.id === toolName);

  const registerStatusTools = (targetServer: McpServer, collectToolNames: boolean) => {
    if (!hasImplementedBridgeTool(ACPX_STATUS_MCP_TOOL_NAME)) {
      if (collectToolNames) {
        params.logger?.warn("acpx MCP status bridge started with no allowlisted status tools");
      }
      return;
    }

    targetServer.registerTool(
      ACPX_STATUS_MCP_TOOL_NAME,
      {
        title: "Fased Effective Tools Preview",
        description:
          "Preview the read-only effective Fased tool inventory for the default agent context. This does not execute tools.",
        inputSchema: {
          agentId: z.string().trim().min(1).optional(),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        const result = await previewEffectiveTools({
          agentId: normalizeOptionalString((args as { agentId?: unknown }).agentId),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    );
    if (collectToolNames) {
      toolNames.push(ACPX_STATUS_MCP_TOOL_NAME);
    }
  };

  const registerGatewayIdentityTool = (targetServer: McpServer, collectToolNames: boolean) => {
    if (!hasImplementedBridgeTool(ACPX_GATEWAY_IDENTITY_MCP_TOOL_NAME)) {
      return;
    }

    targetServer.registerTool(
      ACPX_GATEWAY_IDENTITY_MCP_TOOL_NAME,
      {
        title: "Fased Gateway Identity",
        description:
          "Read the sanitized public Fased gateway device identity. This does not expose private key material.",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const result = await previewGatewayIdentity();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    );
    if (collectToolNames) {
      toolNames.push(ACPX_GATEWAY_IDENTITY_MCP_TOOL_NAME);
    }
  };

  const registerGatewayStatusTool = (targetServer: McpServer, collectToolNames: boolean) => {
    if (!hasImplementedBridgeTool(ACPX_GATEWAY_STATUS_MCP_TOOL_NAME)) {
      return;
    }

    targetServer.registerTool(
      ACPX_GATEWAY_STATUS_MCP_TOOL_NAME,
      {
        title: "Fased Gateway Status",
        description:
          "Read sanitized Fased gateway status. This omits local paths, queued event text, and recent session details.",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const result = await previewGatewayStatus();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    );
    if (collectToolNames) {
      toolNames.push(ACPX_GATEWAY_STATUS_MCP_TOOL_NAME);
    }
  };

  const registerModelsCatalogStatusTool = (targetServer: McpServer, collectToolNames: boolean) => {
    if (!hasImplementedBridgeTool(ACPX_MODELS_CATALOG_STATUS_MCP_TOOL_NAME)) {
      return;
    }

    targetServer.registerTool(
      ACPX_MODELS_CATALOG_STATUS_MCP_TOOL_NAME,
      {
        title: "Fased Models Catalog Status",
        description:
          "Read sanitized Fased provider/model catalog status. This does not expose provider base URLs or API keys.",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const result = await previewModelsCatalogStatus();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    );
    if (collectToolNames) {
      toolNames.push(ACPX_MODELS_CATALOG_STATUS_MCP_TOOL_NAME);
    }
  };

  const registerUpdateStatusTool = (targetServer: McpServer, collectToolNames: boolean) => {
    if (!hasImplementedBridgeTool(ACPX_UPDATE_STATUS_MCP_TOOL_NAME)) {
      return;
    }

    targetServer.registerTool(
      ACPX_UPDATE_STATUS_MCP_TOOL_NAME,
      {
        title: "Fased Update Status",
        description:
          "Read sanitized Fased update status. This does not start an update, fetch git, or query npm.",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const result = await previewUpdateStatus();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    );
    if (collectToolNames) {
      toolNames.push(ACPX_UPDATE_STATUS_MCP_TOOL_NAME);
    }
  };

  const registerCommandsListTool = (targetServer: McpServer, collectToolNames: boolean) => {
    if (!hasImplementedBridgeTool(ACPX_COMMANDS_LIST_MCP_TOOL_NAME)) {
      return;
    }

    targetServer.registerTool(
      ACPX_COMMANDS_LIST_MCP_TOOL_NAME,
      {
        title: "Fased Commands List",
        description:
          "Read Fased command metadata for the selected agent context. This does not invoke commands.",
        inputSchema: {
          agentId: z.string().trim().min(1).optional(),
          provider: z.string().trim().min(1).optional(),
          scope: z.enum(["native", "text", "both"]).optional(),
          includeArgs: z.boolean().optional(),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        const result = await previewCommandsList({
          agentId: normalizeOptionalString((args as { agentId?: unknown }).agentId),
          provider: normalizeOptionalString((args as { provider?: unknown }).provider),
          scope: normalizeCommandScope((args as { scope?: unknown }).scope),
          includeArgs: (args as { includeArgs?: unknown }).includeArgs !== false,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    );
    if (collectToolNames) {
      toolNames.push(ACPX_COMMANDS_LIST_MCP_TOOL_NAME);
    }
  };

  const registerAcpStatusTool = (targetServer: McpServer, collectToolNames: boolean) => {
    if (!hasImplementedBridgeTool(ACPX_ACP_STATUS_MCP_TOOL_NAME)) {
      return;
    }

    targetServer.registerTool(
      ACPX_ACP_STATUS_MCP_TOOL_NAME,
      {
        title: "Fased ACP Status",
        description:
          "Read ACP/session bridge status without ensuring, reconciling, or mutating sessions.",
        inputSchema: {
          limit: z.number().int().min(0).max(100).optional(),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        const result = await previewAcpStatus({
          limit: normalizeAcpStatusLimit((args as { limit?: unknown }).limit),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    );
    if (collectToolNames) {
      toolNames.push(ACPX_ACP_STATUS_MCP_TOOL_NAME);
    }
  };

  const registerPushTestRequestTool = (targetServer: McpServer, collectToolNames: boolean) => {
    if (!hasImplementedMutatingBridgeTool(ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME)) {
      return;
    }

    targetServer.registerTool(
      ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME,
      {
        title: "Fased Push Test Request",
        description:
          "Execute the fixed ACPX push-test wrapper only after operator approval, runtime gate, audit, and rate-limit checks admit the exact request.",
        inputSchema: {
          schemaVersion: z.literal(1),
          kind: z.literal("acpx.mutating-wrapper.push-test.execution.request"),
          wrapperId: z.literal(ACPX_PUSH_TEST_WRAPPER_ID),
          method: z.literal(ACPX_PUSH_TEST_METHOD),
          dryRun: z.literal(true),
          requestId: z.string().trim().min(1),
          createdAt: z.string().trim().min(1),
          params: z
            .object({
              nodeId: z.string().trim().min(1),
              title: z.string().optional(),
              body: z.string().optional(),
              environment: z.enum(["sandbox", "production"]).optional(),
            })
            .strict(),
          approval: z
            .object({
              confirmation: z.enum(["none", "operator-confirmed"]),
              acceptedRequestFingerprint: z.string().optional(),
              operatorId: z.string().optional(),
              approvedAt: z.string().optional(),
            })
            .strict(),
          gate: z
            .object({
              gates: z.record(z.string(), z.boolean()).optional(),
              forbiddenSurfaces: z.record(z.string(), z.boolean()).optional(),
              allowWrappers: z.array(z.string()).optional(),
              denyWrappers: z.array(z.string()).optional(),
            })
            .strict(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        const result = await executePushTestRequest(args as AcpxPushTestApprovalContractRequest);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    );
    if (collectToolNames) {
      toolNames.push(ACPX_PUSH_TEST_REQUEST_MCP_TOOL_NAME);
    }
  };

  const createStatusServerInstance = (collectToolNames = false) => {
    const nextServer = new McpServer({
      name: "fased-acpx-status",
      version: "0.1.0",
    });
    registerStatusTools(nextServer, collectToolNames);
    registerGatewayIdentityTool(nextServer, collectToolNames);
    registerGatewayStatusTool(nextServer, collectToolNames);
    registerModelsCatalogStatusTool(nextServer, collectToolNames);
    registerUpdateStatusTool(nextServer, collectToolNames);
    registerCommandsListTool(nextServer, collectToolNames);
    registerAcpStatusTool(nextServer, collectToolNames);
    registerPushTestRequestTool(nextServer, collectToolNames);
    return nextServer;
  };

  const server = createStatusServerInstance(true);

  return {
    server,
    toolNames,
    async startEndpoint() {
      if (closed) {
        throw new Error("ACPX MCP status server is closed");
      }
      if (endpoint) {
        return endpoint;
      }
      const token = createCapabilityToken();
      const nextHttpServer = createServer((req, res) => {
        const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        if (requestUrl.pathname !== "/mcp") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        if (
          !isAuthorizedRequest({
            authorization: req.headers.authorization,
            token,
          })
        ) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }

        void (async () => {
          const requestServer = createStatusServerInstance();
          const requestTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          activeRequestServers.add(requestServer);
          activeRequestTransports.add(requestTransport);
          try {
            await requestServer.connect(requestTransport);
            await requestTransport.handleRequest(req, res);
          } catch (error) {
            params.logger?.warn(`acpx MCP status request failed: ${String(error)}`);
            if (!res.headersSent) {
              res.writeHead(500, { "content-type": "application/json" });
            }
            res.end(JSON.stringify({ error: "mcp_request_failed" }));
          } finally {
            activeRequestTransports.delete(requestTransport);
            activeRequestServers.delete(requestServer);
            await requestTransport.close().catch(() => {});
            await requestServer.close().catch(() => {});
          }
        })();
      });

      try {
        const port = await listen(nextHttpServer);
        httpServer = nextHttpServer;
        endpoint = {
          url: `http://127.0.0.1:${port}/mcp`,
          token,
          toolNames: [...toolNames],
          mode: params.bridgeConfig.mode,
        };
        return endpoint;
      } catch (error) {
        await closeHttpServer(nextHttpServer).catch(() => {});
        throw error;
      }
    },
    getEndpoint() {
      return endpoint;
    },
    previewEffectiveTools,
    previewGatewayStatus,
    previewModelsCatalogStatus,
    previewUpdateStatus,
    previewCommandsList,
    previewAcpStatus,
    executePushTestRequest,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      endpoint = null;
      await Promise.all(
        [...activeRequestTransports].map((activeTransport) =>
          activeTransport.close().catch(() => {}),
        ),
      );
      activeRequestTransports.clear();
      await Promise.all(
        [...activeRequestServers].map((activeServer) => activeServer.close().catch(() => {})),
      );
      activeRequestServers.clear();
      await (httpServer ? closeHttpServer(httpServer) : Promise.resolve()).catch(() => {});
      httpServer = null;
      await server.close();
    },
    isClosed() {
      return closed;
    },
  };
}
