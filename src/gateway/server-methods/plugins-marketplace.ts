import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { resolveChannelPluginExpectedPluginIds } from "../../channels/plugins/catalog.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { resolvePluginAdminRpcActionSourceKeys } from "../../plugins/config-state.js";
import { installPluginFromNpmSpec } from "../../plugins/install.js";
import { buildNpmResolutionInstallFields } from "../../plugins/installs.js";
import {
  executePluginUninstallLifecycle,
  executePluginUpdateLifecycle,
  finalizeInstalledPluginConfig,
} from "../../plugins/lifecycle.js";
import { clearPluginManifestRegistryCache } from "../../plugins/manifest-registry.js";
import {
  buildPluginMarketplaceUpdateReview,
  formatPluginMarketplaceUpdateReviewWarnings,
  type PluginMarketplaceUpdateReview,
} from "../../plugins/marketplace-update-review.js";
import {
  buildPluginMarketplaceReport,
  type PluginMarketplaceEntry,
  resolvePluginMarketplaceEntry,
} from "../../plugins/marketplace.js";
import {
  setPluginAdminRpcActionGrant,
  setPluginRuntimeSessionReadGrant,
} from "../../plugins/runtime-helper-grants.js";
import {
  ErrorCodes,
  errorShape,
  validatePluginsMarketplaceInfoParams,
  validatePluginsMarketplaceAdminRpcGrantSetParams,
  validatePluginsMarketplaceInstallParams,
  validatePluginsMarketplaceListParams,
  validatePluginsMarketplaceRestartParams,
  validatePluginsMarketplaceRuntimeHelperSetParams,
  validatePluginsMarketplaceUninstallParams,
  validatePluginsMarketplaceUpdatePreviewParams,
  validatePluginsMarketplaceUpdateParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function resolveAgentIdOrRespondError(rawAgentId: unknown, respond: RespondFn) {
  const cfg = loadConfig();
  const knownAgents = listAgentIds(cfg);
  const requestedAgentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
  const agentId = requestedAgentId || resolveDefaultAgentId(cfg);
  if (requestedAgentId && !knownAgents.includes(agentId)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return {
    cfg,
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
  };
}

function resolveMarketplacePluginOrRespond(params: {
  id: string;
  agentId: unknown;
  requiredAction?: "install" | "update" | "uninstall";
  respond: RespondFn;
}) {
  const resolved = resolveAgentIdOrRespondError(params.agentId, params.respond);
  if (!resolved) {
    return null;
  }
  const report = buildPluginMarketplaceReport({
    config: resolved.cfg,
    ...(resolved.workspaceDir ? { workspaceDir: resolved.workspaceDir } : {}),
  });
  const plugin = resolvePluginMarketplaceEntry({
    idOrName: params.id,
    report,
  });
  if (!plugin) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `plugin not found in marketplace: ${params.id}`),
    );
    return null;
  }
  if (params.requiredAction && !plugin.actions.includes(params.requiredAction)) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `plugin ${plugin.id} does not support marketplace action "${params.requiredAction}"`,
      ),
    );
    return null;
  }
  return { ...resolved, report, plugin };
}

function respondActionSuccess(params: {
  respond: RespondFn;
  action: "install" | "update" | "uninstall" | "restart" | "runtime-helper" | "admin-rpc-grant";
  pluginId: string;
  changed: boolean;
  requiresRestart: boolean;
  message: string;
  warnings?: string[];
  updateReview?: PluginMarketplaceUpdateReview;
}) {
  params.respond(
    true,
    {
      action: params.action,
      pluginId: params.pluginId,
      changed: params.changed,
      requiresRestart: params.requiresRestart,
      message: params.message,
      warnings: params.warnings ?? [],
      ...(params.updateReview ? { updateReview: params.updateReview } : {}),
    },
    undefined,
  );
}

function resolveInstallChoice(plugin: PluginMarketplaceEntry, requestedChoice?: unknown) {
  const preferred = typeof requestedChoice === "string" ? requestedChoice.trim() : "";
  if (preferred === "local" || preferred === "npm") {
    return preferred;
  }
  if (
    plugin.installOptions.defaultChoice === "local" ||
    plugin.installOptions.defaultChoice === "npm"
  ) {
    return plugin.installOptions.defaultChoice;
  }
  if (plugin.installOptions.resolvedLocalPath || plugin.installOptions.bundledLocalPath) {
    return "local";
  }
  if (plugin.installOptions.npmSpec) {
    return "npm";
  }
  return null;
}

function resolveInstallLocalPath(plugin: PluginMarketplaceEntry) {
  return plugin.installOptions.resolvedLocalPath ?? plugin.installOptions.bundledLocalPath ?? null;
}

async function buildPluginUpdatePreview(params: {
  config: ReturnType<typeof loadConfig>;
  plugin: PluginMarketplaceEntry;
}) {
  const result = await executePluginUpdateLifecycle({
    config: params.config,
    pluginIds: [params.plugin.id],
    dryRun: true,
  });
  const outcome = result.outcomes[0];
  if (!outcome || outcome.status === "error") {
    return {
      ok: false as const,
      message: outcome?.message ?? `failed to preview plugin update ${params.plugin.id}`,
    };
  }
  const updateReview = buildPluginMarketplaceUpdateReview({
    entry: params.plugin,
    outcome,
  });
  return {
    ok: true as const,
    outcome,
    updateReview,
    warnings: formatPluginMarketplaceUpdateReviewWarnings(updateReview),
  };
}

export const pluginsMarketplaceHandlers: GatewayRequestHandlers = {
  "plugins.marketplace.list": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsMarketplaceListParams,
        "plugins.marketplace.list",
        respond,
      )
    ) {
      return;
    }

    const resolved = resolveAgentIdOrRespondError(params.agentId, respond);
    if (!resolved) {
      return;
    }

    const report = buildPluginMarketplaceReport({
      config: resolved.cfg,
      ...(resolved.workspaceDir ? { workspaceDir: resolved.workspaceDir } : {}),
    });
    respond(
      true,
      {
        agentId: resolved.agentId,
        ...(report.workspaceDir ? { workspaceDir: report.workspaceDir } : {}),
        plugins: report.plugins,
        diagnostics: report.diagnostics,
      },
      undefined,
    );
  },
  "plugins.marketplace.info": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsMarketplaceInfoParams,
        "plugins.marketplace.info",
        respond,
      )
    ) {
      return;
    }

    const resolved = resolveAgentIdOrRespondError(params.agentId, respond);
    if (!resolved) {
      return;
    }

    const report = buildPluginMarketplaceReport({
      config: resolved.cfg,
      ...(resolved.workspaceDir ? { workspaceDir: resolved.workspaceDir } : {}),
    });
    const plugin = resolvePluginMarketplaceEntry({
      idOrName: params.id,
      report,
    });
    if (!plugin) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `plugin not found in marketplace: ${params.id}`),
      );
      return;
    }

    respond(
      true,
      {
        agentId: resolved.agentId,
        ...(report.workspaceDir ? { workspaceDir: report.workspaceDir } : {}),
        plugin,
        diagnostics: report.diagnostics,
      },
      undefined,
    );
  },
  "plugins.marketplace.install": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsMarketplaceInstallParams,
        "plugins.marketplace.install",
        respond,
      )
    ) {
      return;
    }

    const resolved = resolveMarketplacePluginOrRespond({
      id: params.id,
      agentId: params.agentId,
      requiredAction: "install",
      respond,
    });
    if (!resolved) {
      return;
    }

    const choice = resolveInstallChoice(resolved.plugin, params.sourceChoice);
    if (choice === "local") {
      const localPath = resolveInstallLocalPath(resolved.plugin);
      if (!localPath) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `plugin ${resolved.plugin.id} has no local install path available`,
          ),
        );
        return;
      }
      const isBundledLocalPlugin = resolved.plugin.origin === "bundled";
      const finalized = finalizeInstalledPluginConfig({
        config: resolved.cfg,
        pluginId: resolved.plugin.id,
        refreshManifestRegistry: true,
        ...(isBundledLocalPlugin
          ? {}
          : {
              loadPath: localPath,
              installRecord: {
                source: "path" as const,
                sourcePath: localPath,
                installPath: localPath,
                version: resolved.plugin.version,
              },
            }),
      });
      await writeConfigFile(finalized.config);
      respondActionSuccess({
        respond,
        action: "install",
        pluginId: resolved.plugin.id,
        changed: true,
        requiresRestart: true,
        message: isBundledLocalPlugin
          ? `Enabled bundled plugin: ${resolved.plugin.id}. Restart the gateway to load it.`
          : `Linked plugin path: ${localPath}`,
        warnings: finalized.slotWarnings,
      });
      return;
    }

    const npmSpec = resolved.plugin.installOptions.npmSpec?.trim();
    if (!npmSpec) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `plugin ${resolved.plugin.id} has no npm install source available`,
        ),
      );
      return;
    }

    const result = await installPluginFromNpmSpec({
      spec: npmSpec,
      expectedPluginId: resolved.plugin.id,
      ...(resolved.plugin.channelCatalog
        ? {
            expectedPluginIds: resolveChannelPluginExpectedPluginIds({
              id: resolved.plugin.id,
              meta: resolved.plugin.channelCatalog,
            }),
          }
        : {}),
      ...(resolved.plugin.installOptions.expectedIntegrity
        ? { expectedIntegrity: resolved.plugin.installOptions.expectedIntegrity }
        : {}),
    });
    if (!result.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, result.error));
      return;
    }

    const finalized = finalizeInstalledPluginConfig({
      config: resolved.cfg,
      pluginId: result.pluginId,
      refreshManifestRegistry: true,
      installRecord: {
        source: "npm",
        spec: npmSpec,
        installPath: result.targetDir,
        version: result.version,
        ...buildNpmResolutionInstallFields(result.npmResolution),
      },
    });
    await writeConfigFile(finalized.config);
    respondActionSuccess({
      respond,
      action: "install",
      pluginId: result.pluginId,
      changed: true,
      requiresRestart: true,
      message: `Installed plugin: ${result.pluginId}`,
      warnings: finalized.slotWarnings,
    });
  },
  "plugins.marketplace.restart": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsMarketplaceRestartParams,
        "plugins.marketplace.restart",
        respond,
      )
    ) {
      return;
    }

    const resolved = resolveMarketplacePluginOrRespond({
      id: params.id,
      agentId: params.agentId,
      respond,
    });
    if (!resolved) {
      return;
    }

    const restart = scheduleGatewaySigusr1Restart({
      reason: `plugins.marketplace.restart:${resolved.plugin.id}`,
    });

    respondActionSuccess({
      respond,
      action: "restart",
      pluginId: resolved.plugin.id,
      changed: false,
      requiresRestart: false,
      message: restart.coalesced
        ? `Gateway restart already pending for plugin runtime: ${resolved.plugin.id}`
        : `Scheduled gateway restart for plugin runtime: ${resolved.plugin.id}`,
      warnings: restart.coalesced
        ? ["A gateway restart was already pending; the runtime will reload on that restart."]
        : ["The control UI will reconnect automatically after the gateway restarts."],
    });
  },
  "plugins.marketplace.runtimeHelper.set": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsMarketplaceRuntimeHelperSetParams,
        "plugins.marketplace.runtimeHelper.set",
        respond,
      )
    ) {
      return;
    }

    const resolved = resolveMarketplacePluginOrRespond({
      id: params.id,
      agentId: params.agentId,
      respond,
    });
    if (!resolved) {
      return;
    }

    const result = setPluginRuntimeSessionReadGrant(
      resolved.cfg,
      resolved.plugin.id,
      params.enabled,
    );
    if (result.changed) {
      await writeConfigFile(result.config);
    }

    respondActionSuccess({
      respond,
      action: "runtime-helper",
      pluginId: result.pluginId,
      changed: result.changed,
      requiresRestart: result.changed,
      message: result.enabled
        ? result.changed
          ? `Enabled runtime.helpers.sessions.read for plugin: ${result.pluginId}`
          : `runtime.helpers.sessions.read is already enabled for plugin: ${result.pluginId}`
        : result.changed
          ? `Disabled runtime.helpers.sessions.read for plugin: ${result.pluginId}`
          : `runtime.helpers.sessions.read is already disabled for plugin: ${result.pluginId}`,
      warnings: result.changed
        ? ["Restart the gateway to apply this helper grant to the active plugin runtime."]
        : [],
    });
  },
  "plugins.marketplace.adminRpcGrant.set": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsMarketplaceAdminRpcGrantSetParams,
        "plugins.marketplace.adminRpcGrant.set",
        respond,
      )
    ) {
      return;
    }

    const resolved = resolveMarketplacePluginOrRespond({
      id: params.id,
      agentId: params.agentId,
      respond,
    });
    if (!resolved) {
      return;
    }

    const sourceKeys = resolvePluginAdminRpcActionSourceKeys({
      ...(resolved.plugin.origin ? { origin: resolved.plugin.origin } : {}),
      ...(resolved.plugin.source ? { source: resolved.plugin.source } : {}),
    }).filter((key) => key.startsWith("origin:") || key.startsWith("source:"));
    if (params.enabled && sourceKeys.length === 0) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `plugin ${resolved.plugin.id} has no trusted source keys for admin RPC grants`,
        ),
      );
      return;
    }

    const result = setPluginAdminRpcActionGrant(
      resolved.cfg,
      resolved.plugin.id,
      params.method,
      params.enabled,
      sourceKeys,
    );
    if (result.changed) {
      await writeConfigFile(result.config);
    }

    respondActionSuccess({
      respond,
      action: "admin-rpc-grant",
      pluginId: result.pluginId,
      changed: result.changed,
      requiresRestart: result.changed,
      message: result.enabled
        ? result.changed
          ? `Enabled plugin admin RPC grant ${result.method} for plugin: ${result.pluginId}`
          : `Plugin admin RPC grant ${result.method} is already enabled for plugin: ${result.pluginId}`
        : result.changed
          ? `Disabled plugin admin RPC grant ${result.method} for plugin: ${result.pluginId}`
          : `Plugin admin RPC grant ${result.method} is already disabled for plugin: ${result.pluginId}`,
      warnings: result.changed
        ? [
            "Restart the gateway to apply this admin RPC grant to the active plugin runtime.",
            "The grant still requires operator-scoped calls, runtime audit, and rate limits.",
          ]
        : [],
    });
  },
  "plugins.marketplace.update.preview": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsMarketplaceUpdatePreviewParams,
        "plugins.marketplace.update.preview",
        respond,
      )
    ) {
      return;
    }

    const resolved = resolveMarketplacePluginOrRespond({
      id: params.id,
      agentId: params.agentId,
      requiredAction: "update",
      respond,
    });
    if (!resolved) {
      return;
    }

    const preview = await buildPluginUpdatePreview({
      config: resolved.cfg,
      plugin: resolved.plugin,
    });
    if (!preview.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, preview.message));
      return;
    }
    respond(true, {
      action: "update-preview",
      pluginId: resolved.plugin.id,
      message: preview.outcome.message,
      updateReview: preview.updateReview,
      warnings: preview.warnings,
    });
  },
  "plugins.marketplace.update": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsMarketplaceUpdateParams,
        "plugins.marketplace.update",
        respond,
      )
    ) {
      return;
    }

    const resolved = resolveMarketplacePluginOrRespond({
      id: params.id,
      agentId: params.agentId,
      requiredAction: "update",
      respond,
    });
    if (!resolved) {
      return;
    }

    const preview = await buildPluginUpdatePreview({
      config: resolved.cfg,
      plugin: resolved.plugin,
    });
    if (!preview.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, preview.message));
      return;
    }
    if (preview.updateReview.approvalRequired && params.approveRiskyChanges !== true) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `plugin update requires explicit approval: ${preview.updateReview.reasons.join(", ")}`,
        ),
      );
      return;
    }

    const result = await executePluginUpdateLifecycle({
      config: resolved.cfg,
      pluginIds: [resolved.plugin.id],
    });
    const outcome = result.outcomes[0];
    if (!outcome || outcome.status === "error") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          outcome?.message ?? `failed to update plugin ${resolved.plugin.id}`,
        ),
      );
      return;
    }

    if (result.changed) {
      clearPluginManifestRegistryCache();
      await writeConfigFile(result.config);
    }
    respondActionSuccess({
      respond,
      action: "update",
      pluginId: resolved.plugin.id,
      changed: result.changed,
      requiresRestart: result.changed,
      message: outcome.message,
      warnings: [
        ...preview.warnings,
        ...(outcome.warnings ?? []).map((warning) => `Update warning: ${warning}`),
      ],
      updateReview: preview.updateReview,
    });
  },
  "plugins.marketplace.uninstall": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsMarketplaceUninstallParams,
        "plugins.marketplace.uninstall",
        respond,
      )
    ) {
      return;
    }

    const resolved = resolveMarketplacePluginOrRespond({
      id: params.id,
      agentId: params.agentId,
      requiredAction: "uninstall",
      respond,
    });
    if (!resolved) {
      return;
    }

    const result = await executePluginUninstallLifecycle({
      config: resolved.cfg,
      pluginId: resolved.plugin.id,
      deleteFiles: params.deleteFiles !== false,
    });
    if (!result.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, result.error));
      return;
    }

    clearPluginManifestRegistryCache();
    await writeConfigFile(result.config);
    respondActionSuccess({
      respond,
      action: "uninstall",
      pluginId: resolved.plugin.id,
      changed: true,
      requiresRestart: true,
      message: `Uninstalled plugin: ${resolved.plugin.id}`,
      warnings: result.warnings,
    });
  },
};
