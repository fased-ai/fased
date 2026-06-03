import type {
  AcpRuntime,
  FasedAgentPluginService,
  FasedAgentPluginServiceContext,
  PluginLogger,
} from "fased/plugin-sdk";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "fased/plugin-sdk";
import {
  ACPX_PINNED_VERSION,
  resolveAcpxPluginConfig,
  type ResolvedAcpxPluginConfig,
} from "./config.js";
import { ensurePinnedAcpx } from "./ensure.js";
import {
  createAcpxMcpStatusServer,
  type AcpxMcpStatusEndpoint,
  type AcpxMcpStatusServer,
  type CreateAcpxMcpStatusServerParams,
} from "./mcp-status-server.js";
import { ACPX_BACKEND_ID, AcpxRuntime } from "./runtime.js";

type AcpxRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
};

type AcpxRuntimeFactoryParams = {
  pluginConfig: ResolvedAcpxPluginConfig;
  queueOwnerTtlSeconds: number;
  logger?: PluginLogger;
  mcpStatusEndpoint?: AcpxMcpStatusEndpoint;
};

type CreateAcpxRuntimeServiceParams = {
  pluginConfig?: unknown;
  runtimeFactory?: (params: AcpxRuntimeFactoryParams) => AcpxRuntimeLike;
  mcpStatusServerFactory?: (
    params: CreateAcpxMcpStatusServerParams,
  ) => AcpxMcpStatusServer | Promise<AcpxMcpStatusServer>;
};

function createDefaultRuntime(params: AcpxRuntimeFactoryParams): AcpxRuntimeLike {
  return new AcpxRuntime(params.pluginConfig, {
    logger: params.logger,
    queueOwnerTtlSeconds: params.queueOwnerTtlSeconds,
    mcpStatusEndpoint: params.mcpStatusEndpoint,
  });
}

export function createAcpxRuntimeService(
  params: CreateAcpxRuntimeServiceParams = {},
): FasedAgentPluginService {
  let runtime: AcpxRuntimeLike | null = null;
  let mcpStatusServer: AcpxMcpStatusServer | null = null;
  let lifecycleRevision = 0;

  return {
    id: "acpx-runtime",
    async start(ctx: FasedAgentPluginServiceContext): Promise<void> {
      const pluginConfig = resolveAcpxPluginConfig({
        rawConfig: params.pluginConfig,
        workspaceDir: ctx.workspaceDir,
      });
      let mcpStatusEndpoint: AcpxMcpStatusEndpoint | undefined;
      if (pluginConfig.mcpBridge.enabled) {
        const mcpFactory = params.mcpStatusServerFactory ?? createAcpxMcpStatusServer;
        try {
          mcpStatusServer = await mcpFactory({
            bridgeConfig: pluginConfig.mcpBridge,
            context: ctx,
            logger: ctx.logger,
          });
          mcpStatusEndpoint = await mcpStatusServer.startEndpoint();
          ctx.logger.info(
            `acpx MCP status bridge ready (${mcpStatusServer.toolNames.length} tool(s), ${mcpStatusEndpoint.url})`,
          );
        } catch (error) {
          await mcpStatusServer?.close();
          mcpStatusServer = null;
          throw error;
        }
      }
      const runtimeFactory = params.runtimeFactory ?? createDefaultRuntime;
      try {
        runtime = runtimeFactory({
          pluginConfig,
          queueOwnerTtlSeconds: pluginConfig.queueOwnerTtlSeconds,
          logger: ctx.logger,
          mcpStatusEndpoint,
        });

        registerAcpRuntimeBackend({
          id: ACPX_BACKEND_ID,
          runtime,
          healthy: () => runtime?.isHealthy() ?? false,
        });
      } catch (error) {
        await mcpStatusServer?.close();
        mcpStatusServer = null;
        throw error;
      }
      ctx.logger.info(
        `acpx runtime backend registered (command: ${pluginConfig.command}, pinned: ${ACPX_PINNED_VERSION})`,
      );

      lifecycleRevision += 1;
      const currentRevision = lifecycleRevision;
      void (async () => {
        try {
          await ensurePinnedAcpx({
            command: pluginConfig.command,
            logger: ctx.logger,
            expectedVersion: ACPX_PINNED_VERSION,
          });
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          await runtime?.probeAvailability();
          if (runtime?.isHealthy()) {
            ctx.logger.info("acpx runtime backend ready");
          } else {
            ctx.logger.warn("acpx runtime backend probe failed after local install");
          }
        } catch (err) {
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          ctx.logger.warn(
            `acpx runtime setup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    },
    async stop(_ctx: FasedAgentPluginServiceContext): Promise<void> {
      lifecycleRevision += 1;
      await mcpStatusServer?.close();
      mcpStatusServer = null;
      unregisterAcpRuntimeBackend(ACPX_BACKEND_ID);
      runtime = null;
    },
  };
}
