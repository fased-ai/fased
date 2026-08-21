import { Type } from "@sinclair/typebox";
import type { FasedAgentConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { listRuntimeImageGenerationProviders } from "../image-generation/runtime.js";
import { resolvePluginTools } from "../plugins/tools.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { listRuntimeVideoGenerationProviders } from "../video-generation/runtime.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { resolveFasedCompatPluginToolInputs } from "./fased-tools.compat.plugin-context.js";
import { resolveEnvApiKey } from "./model-auth.js";
import { applyPluginToolDeliveryDefaults } from "./plugin-tool-delivery-defaults.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { jsonResult } from "./tools/common.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import {
  createOffersTool,
  createMarketplaceOfferDraftTool,
  createMarketplaceRequestDraftTool,
  createMarketplaceTool,
} from "./tools/marketplace-offer-draft-tool.js";
import {
  createImageGenerateTool,
  createVideoGenerateTool,
} from "./tools/media-generation-tools.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createMiningTool } from "./tools/mining-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./tools/sessions-helpers.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

type FasedCompatToolsDeps = {
  config?: FasedAgentConfig;
};

const defaultFasedCompatToolsDeps: FasedCompatToolsDeps = {};
let fasedCompatToolsDeps: FasedCompatToolsDeps = defaultFasedCompatToolsDeps;

const EmptyToolSchema = Type.Object({});
const UpdatePlanToolSchema = Type.Object({
  explanation: Type.Optional(Type.String()),
  plan: Type.Array(
    Type.Object({
      status: Type.String(),
      step: Type.String(),
    }),
  ),
});

type FasedCompatTool = AnyAgentTool & {
  displaySummary?: string;
};

function createCompatTool(params: {
  label: string;
  name: string;
  description: string;
  displaySummary?: string;
  parameters?: typeof EmptyToolSchema;
}): FasedCompatTool {
  return {
    label: params.label,
    name: params.name,
    description: params.description,
    parameters: params.parameters ?? EmptyToolSchema,
    ...(params.displaySummary ? { displaySummary: params.displaySummary } : {}),
    execute: async (_toolCallId, args) =>
      jsonResult({
        status: "unsupported",
        tool: params.name,
        args,
      }),
  };
}

function isOpenAIProvider(provider?: string): boolean {
  const normalized = provider?.trim().toLowerCase();
  return normalized === "openai" || normalized === "openai-codex";
}

function isExperimentalPlanToolEnabled(config?: FasedAgentConfig): boolean {
  return (
    (config?.tools as { experimental?: { planTool?: boolean } } | undefined)?.experimental
      ?.planTool === true
  );
}

function hasModelPrimary(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { primary?: unknown }).primary === "string" &&
    (value as { primary: string }).primary.trim().length > 0,
  );
}

function hasConfiguredPdfModel(config?: FasedAgentConfig): boolean {
  const defaults = (config as { agents?: { defaults?: { pdfModel?: unknown } } } | undefined)
    ?.agents?.defaults;
  return hasModelPrimary(defaults?.pdfModel);
}

function hasConfiguredImageGenerationModel(config?: FasedAgentConfig): boolean {
  return hasModelPrimary(config?.agents?.defaults?.imageGenerationModel);
}

function hasConfiguredVideoGenerationModel(config?: FasedAgentConfig): boolean {
  return hasModelPrimary(config?.agents?.defaults?.videoGenerationModel);
}

function hasEnvVar(name: string): boolean {
  return typeof process.env[name] === "string" && process.env[name].trim().length > 0;
}

function hasEnvBackedProviderAuth(providerId?: string): boolean {
  const normalized = providerId?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (resolveEnvApiKey(normalized)?.apiKey) {
    return true;
  }

  switch (normalized) {
    case "openai":
      return hasEnvVar("OPENAI_API_KEYS");
    case "google":
      return hasEnvVar("GEMINI_API_KEYS");
    case "qwen":
    case "modelstudio":
    case "dashscope":
      return (
        hasEnvVar("QWEN_API_KEY") ||
        hasEnvVar("MODELSTUDIO_API_KEY") ||
        hasEnvVar("DASHSCOPE_API_KEY")
      );
    default:
      return false;
  }
}

function shouldRegisterImageGenerateTool(config?: FasedAgentConfig): boolean {
  if (hasConfiguredImageGenerationModel(config)) {
    return true;
  }
  return listRuntimeImageGenerationProviders({ config }).some((provider) =>
    hasEnvBackedProviderAuth(provider.id),
  );
}

function shouldRegisterVideoGenerateTool(config?: FasedAgentConfig): boolean {
  if (hasConfiguredVideoGenerationModel(config)) {
    return true;
  }
  return listRuntimeVideoGenerationProviders({ config }).some((provider) =>
    hasEnvBackedProviderAuth(provider.id),
  );
}

function shouldRegisterBrowserCompatTool(config?: FasedAgentConfig): boolean {
  const normalizedAllow = new Set(
    (config?.plugins?.allow ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean),
  );
  const browserEntry = config?.plugins?.entries?.browser;
  if (browserEntry?.enabled === false || config?.plugins?.enabled === false) {
    return false;
  }
  return normalizedAllow.has("browser") || browserEntry?.enabled === true;
}

function createFasedCompatAgentsListTool(opts?: {
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
}): FasedCompatTool {
  return {
    label: "Agents",
    name: "agents_list",
    description:
      'List FasedAgent agent ids you can target with `sessions_spawn` when `runtime="subagent"` (based on subagent allowlists).',
    parameters: EmptyToolSchema,
    execute: async () => {
      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterInternalKey =
        typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()
          ? resolveInternalSessionKey({
              key: opts.agentSessionKey,
              alias,
              mainKey,
            })
          : alias;
      const requesterAgentId = normalizeAgentId(
        opts?.requesterAgentIdOverride ??
          parseAgentSessionKey(requesterInternalKey)?.agentId ??
          DEFAULT_AGENT_ID,
      );
      const agentConfig = resolveAgentConfig(cfg, requesterAgentId);
      const defaultSubagents = cfg.agents?.defaults?.subagents as
        | { allowAgents?: string[] }
        | undefined;
      const allowAgents =
        agentConfig?.subagents?.allowAgents ?? defaultSubagents?.allowAgents ?? [];
      const allowAny = allowAgents.some((value: string) => value.trim() === "*");
      const allowSet = new Set(
        allowAgents
          .filter((value: string) => value.trim() && value.trim() !== "*")
          .map((value: string) => normalizeAgentId(value)),
      );
      const configuredAgents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
      const configuredIds = configuredAgents.map((entry) => normalizeAgentId(entry.id));
      const configuredNameMap = new Map<string, string>();
      for (const entry of configuredAgents) {
        const name = entry?.name?.trim() ?? "";
        if (name) {
          configuredNameMap.set(normalizeAgentId(entry.id), name);
        }
      }

      const allowed = new Set<string>([requesterAgentId]);
      if (allowAny) {
        for (const id of configuredIds) {
          allowed.add(id);
        }
      } else {
        for (const id of allowSet) {
          allowed.add(id);
        }
      }

      const ordered = [
        requesterAgentId,
        ...Array.from(allowed)
          .filter((id) => id !== requesterAgentId)
          .toSorted((a, b) => a.localeCompare(b)),
      ];
      return jsonResult({
        requester: requesterAgentId,
        allowAny,
        agents: ordered.map((id) => ({
          id,
          name: configuredNameMap.get(id),
          configured: configuredIds.includes(id),
        })),
      });
    },
  };
}

export function createFasedCompatTools(options?: {
  sandboxBrowserBridgeUrl?: string;
  allowHostBrowserControl?: boolean;
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  agentDir?: string;
  sandboxRoot?: string;
  sandboxFsBridge?: SandboxFsBridge;
  fsPolicy?: ToolFsPolicy;
  workspaceDir?: string;
  sandboxed?: boolean;
  config?: FasedAgentConfig;
  pluginToolAllowlist?: string[];
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };
  modelHasVision?: boolean;
  modelProvider?: string;
  requesterAgentIdOverride?: string;
  requireExplicitMessageTarget?: boolean;
  disableMessageTool?: boolean;
  disablePluginTools?: boolean;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
  sessionId?: string;
  spawnWorkspaceDir?: string;
  allowGatewaySubagentBinding?: boolean;
}): FasedCompatTool[] {
  const resolvedConfig = options?.config ?? fasedCompatToolsDeps.config;
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  const sandbox =
    options?.sandboxRoot && options?.sandboxFsBridge
      ? { root: options.sandboxRoot, bridge: options.sandboxFsBridge }
      : undefined;

  const imageTool = options?.agentDir?.trim()
    ? createImageTool({
        config: resolvedConfig,
        agentDir: options.agentDir,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
        modelHasVision: options?.modelHasVision,
      })
    : null;
  const webSearchTool = createWebSearchTool({
    config: resolvedConfig,
    sandboxed: options?.sandboxed,
  });
  const webFetchTool = createWebFetchTool({
    config: resolvedConfig,
    sandboxed: options?.sandboxed,
  });
  const messageTool = options?.disableMessageTool
    ? null
    : createMessageTool({
        agentAccountId: options?.agentAccountId,
        agentSessionKey: options?.agentSessionKey,
        config: resolvedConfig,
        currentChannelId: options?.currentChannelId,
        currentChannelProvider: options?.agentChannel,
        currentThreadTs: options?.currentThreadTs,
        currentMessageId: options?.currentMessageId,
        replyToMode: options?.replyToMode,
        hasRepliedRef: options?.hasRepliedRef,
        sandboxRoot: options?.sandboxRoot,
        requireExplicitTarget: options?.requireExplicitMessageTarget,
        requesterSenderId: options?.requesterSenderId ?? undefined,
        senderIsOwner: options?.senderIsOwner,
      });

  const tools: FasedCompatTool[] = [
    ...(shouldRegisterBrowserCompatTool(resolvedConfig)
      ? [
          createBrowserTool({
            sandboxBridgeUrl: options?.sandboxBrowserBridgeUrl,
            allowHostControl: options?.allowHostBrowserControl,
          }),
        ]
      : []),
    createCanvasTool({ config: resolvedConfig }),
    {
      ...createNodesTool({
        agentSessionKey: options?.agentSessionKey,
        agentChannel: options?.agentChannel,
        agentAccountId: options?.agentAccountId,
        currentChannelId: options?.currentChannelId,
        currentThreadTs: options?.currentThreadTs,
        config: resolvedConfig,
      }),
      ownerOnly: true,
    },
    {
      ...createCronTool({
        agentSessionKey: options?.agentSessionKey,
      }),
      ownerOnly: true,
    },
    ...(messageTool ? [messageTool] : []),
    ...(shouldRegisterImageGenerateTool(resolvedConfig)
      ? [
          createImageGenerateTool({
            config: resolvedConfig,
            agentDir: options?.agentDir,
            agentSessionKey: options?.agentSessionKey,
            agentId: options?.requesterAgentIdOverride,
          }),
        ]
      : []),
    ...(shouldRegisterVideoGenerateTool(resolvedConfig)
      ? [
          createVideoGenerateTool({
            config: resolvedConfig,
            agentDir: options?.agentDir,
            agentSessionKey: options?.agentSessionKey,
            agentId: options?.requesterAgentIdOverride,
          }),
        ]
      : []),
    {
      ...createGatewayTool({
        agentSessionKey: options?.agentSessionKey,
        config: resolvedConfig,
      }),
      ownerOnly: true,
    },
    createMiningTool(),
    createOffersTool(),
    createMarketplaceTool(),
    createMarketplaceOfferDraftTool(),
    createMarketplaceRequestDraftTool(),
    createFasedCompatAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    ...(isExperimentalPlanToolEnabled(resolvedConfig) || isOpenAIProvider(options?.modelProvider)
      ? [
          createCompatTool({
            label: "Plan",
            name: "update_plan",
            description: "Track a short structured work plan.",
            displaySummary: "Track a short structured work plan.",
            parameters: UpdatePlanToolSchema,
          }),
        ]
      : []),
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
    }),
    createSessionsSendTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      sandboxed: options?.sandboxed,
    }),
    createSessionsSpawnTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      agentTo: options?.agentTo,
      agentThreadId: options?.agentThreadId,
      agentGroupId: options?.agentGroupId,
      agentGroupChannel: options?.agentGroupChannel,
      agentGroupSpace: options?.agentGroupSpace,
      sandboxed: options?.sandboxed,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    createSubagentsTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      config: resolvedConfig,
    }),
    ...(webSearchTool ? [webSearchTool] : []),
    ...(webFetchTool ? [webFetchTool] : []),
    ...(imageTool ? [imageTool] : []),
    ...(options?.agentDir?.trim() && hasConfiguredPdfModel(resolvedConfig)
      ? [
          createCompatTool({
            label: "PDF",
            name: "pdf",
            description: "Read and extract content from PDF files.",
          }),
        ]
      : []),
  ];

  if (options?.disablePluginTools) {
    return tools;
  }

  const runtimeSnapshot = getActiveSecretsRuntimeSnapshot();
  const pluginTools = resolvePluginTools({
    ...resolveFasedCompatPluginToolInputs({
      options: {
        ...options,
        workspaceDir,
      },
      resolvedConfig,
      runtimeConfig: runtimeSnapshot?.config,
    }),
    existingToolNames: new Set(tools.map((tool) => tool.name)),
    toolAllowlist: options?.pluginToolAllowlist,
  });

  return [
    ...tools,
    ...applyPluginToolDeliveryDefaults({
      tools: pluginTools,
    }),
  ];
}

export const __testing = {
  setDepsForTest(overrides?: Partial<FasedCompatToolsDeps>) {
    fasedCompatToolsDeps = overrides
      ? { ...defaultFasedCompatToolsDeps, ...overrides }
      : defaultFasedCompatToolsDeps;
  },
} as const;
