import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  PluginMarketplaceEntry,
  PluginMarketplaceAdminRpcActionMethod,
  PluginMarketplaceInstallChoice,
  PluginMarketplaceMutationAction,
  PluginMarketplaceMutationResult,
  PluginMarketplaceUpdatePreviewResult,
  PluginMarketplaceUpdateReview,
  PluginsMarketplaceInfoResult,
  PluginsMarketplaceListResult,
  ExtensionsHooksStatusResult,
  ExtensionsHookToggleResult,
} from "../types.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

export type PluginsMarketplaceRemediationState = {
  pluginId: string;
  action: PluginMarketplaceMutationAction;
  requiresRestart: boolean;
  message: string;
  warnings: string[];
  updateReview?: PluginMarketplaceUpdateReview;
};

export type PluginsMarketplaceState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  pluginsMarketplaceLoading: boolean;
  pluginsMarketplaceDetailLoading: boolean;
  pluginsMarketplaceError: string | null;
  pluginsMarketplaceList: PluginsMarketplaceListResult | null;
  pluginsMarketplaceSelectedId: string | null;
  pluginsMarketplaceDetail: PluginsMarketplaceInfoResult | null;
  pluginsMarketplaceActionBusy: PluginMarketplaceMutationAction | null;
  pluginsMarketplaceMessage: string | null;
  pluginsMarketplaceRemediation: PluginsMarketplaceRemediationState | null;
  extensionsHooksLoading: boolean;
  extensionsHooksError: string | null;
  extensionsHooksStatus: ExtensionsHooksStatusResult | null;
  extensionsHooksBusyKey: string | null;
  extensionsHooksMessage: string | null;
};

function getErrorMessage(err: unknown) {
  if (isMissingOperatorReadScopeError(err)) {
    return formatMissingOperatorReadScopeMessage("the plugin marketplace");
  }
  return String(err);
}

function resolveSelectedPluginId(
  plugins: PluginMarketplaceEntry[],
  requestedId?: string | null,
  existingId?: string | null,
) {
  const preferredId = requestedId?.trim() || existingId?.trim() || "";
  if (preferredId && plugins.some((entry) => entry.id === preferredId)) {
    return preferredId;
  }
  return null;
}

export async function loadPluginMarketplace(
  state: PluginsMarketplaceState,
  opts?: { selectedId?: string | null },
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.pluginsMarketplaceLoading) {
    return;
  }
  state.pluginsMarketplaceLoading = true;
  state.pluginsMarketplaceError = null;
  try {
    const report = await state.client.request<PluginsMarketplaceListResult>(
      "plugins.marketplace.list",
      {},
    );
    state.pluginsMarketplaceList = report;
    const selectedId = resolveSelectedPluginId(
      report.plugins,
      opts?.selectedId,
      state.pluginsMarketplaceSelectedId ?? state.pluginsMarketplaceDetail?.plugin.id ?? null,
    );
    state.pluginsMarketplaceSelectedId = selectedId;
    if (!selectedId) {
      state.pluginsMarketplaceDetail = null;
      return;
    }
    await loadPluginMarketplaceInfo(state, selectedId);
  } catch (err) {
    state.pluginsMarketplaceError = getErrorMessage(err);
  } finally {
    state.pluginsMarketplaceLoading = false;
  }
}

export async function loadExtensionsHooks(state: PluginsMarketplaceState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.extensionsHooksLoading) {
    return;
  }
  state.extensionsHooksLoading = true;
  state.extensionsHooksError = null;
  try {
    state.extensionsHooksStatus = await state.client.request<ExtensionsHooksStatusResult>(
      "hooks.list",
      {},
    );
  } catch (err) {
    state.extensionsHooksError = getErrorMessage(err);
  } finally {
    state.extensionsHooksLoading = false;
  }
}

export async function setExtensionHookEnabled(
  state: PluginsMarketplaceState,
  hookName: string,
  enabled: boolean,
) {
  if (!state.client || !state.connected) {
    return false;
  }
  const name = hookName.trim();
  if (!name) {
    return false;
  }
  state.extensionsHooksBusyKey = name;
  state.extensionsHooksError = null;
  state.extensionsHooksMessage = null;
  try {
    const result = await state.client.request<ExtensionsHookToggleResult>("hooks.setEnabled", {
      name,
      enabled,
    });
    state.extensionsHooksStatus = result.report;
    state.extensionsHooksMessage = `${result.enabled ? "Enabled" : "Disabled"} hook ${result.hookName}.`;
    return true;
  } catch (err) {
    state.extensionsHooksError = getErrorMessage(err);
    return false;
  } finally {
    state.extensionsHooksBusyKey = null;
  }
}

export async function loadPluginMarketplaceInfo(state: PluginsMarketplaceState, pluginId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const id = pluginId.trim();
  if (!id) {
    state.pluginsMarketplaceSelectedId = null;
    state.pluginsMarketplaceDetail = null;
    return;
  }
  state.pluginsMarketplaceDetailLoading = true;
  state.pluginsMarketplaceError = null;
  try {
    const detail = await state.client.request<PluginsMarketplaceInfoResult>(
      "plugins.marketplace.info",
      { id },
    );
    state.pluginsMarketplaceSelectedId = detail.plugin.id;
    state.pluginsMarketplaceDetail = detail;
  } catch (err) {
    state.pluginsMarketplaceError = getErrorMessage(err);
  } finally {
    state.pluginsMarketplaceDetailLoading = false;
  }
}

export async function selectPluginMarketplaceEntry(
  state: PluginsMarketplaceState,
  pluginId: string,
) {
  const id = pluginId.trim();
  if (!id) {
    state.pluginsMarketplaceSelectedId = null;
    state.pluginsMarketplaceDetail = null;
    return;
  }
  if (state.pluginsMarketplaceSelectedId === id) {
    return;
  }
  state.pluginsMarketplaceSelectedId = id;
  await loadPluginMarketplaceInfo(state, id);
}

async function mutatePluginMarketplace(
  state: PluginsMarketplaceState,
  action: PluginMarketplaceMutationAction,
  pluginId: string,
  params?: Record<string, unknown>,
  opts?: { method?: string },
) {
  if (!state.client || !state.connected) {
    return false;
  }
  const id = pluginId.trim();
  if (!id) {
    return false;
  }
  state.pluginsMarketplaceActionBusy = action;
  state.pluginsMarketplaceError = null;
  state.pluginsMarketplaceMessage = null;
  try {
    const result = await state.client.request<PluginMarketplaceMutationResult>(
      opts?.method ?? `plugins.marketplace.${action}`,
      {
        id,
        ...params,
      },
    );
    state.pluginsMarketplaceRemediation = {
      pluginId: result.pluginId,
      action: result.action,
      requiresRestart: result.requiresRestart,
      message: result.message,
      warnings: result.warnings,
      updateReview: result.updateReview,
    };
    const warningText =
      result.warnings.length > 0
        ? `\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}`
        : "";
    state.pluginsMarketplaceMessage = `${result.message}${warningText}`;
    if (action === "restart") {
      return true;
    }
    await loadPluginMarketplace(state, {
      selectedId: action === "uninstall" ? null : id,
    });
    return true;
  } catch (err) {
    state.pluginsMarketplaceError = getErrorMessage(err);
    return false;
  } finally {
    state.pluginsMarketplaceActionBusy = null;
  }
}

export async function installPluginMarketplaceEntry(
  state: PluginsMarketplaceState,
  pluginId: string,
  sourceChoice?: PluginMarketplaceInstallChoice,
) {
  return await mutatePluginMarketplace(
    state,
    "install",
    pluginId,
    sourceChoice ? { sourceChoice } : {},
  );
}

export async function updatePluginMarketplaceEntry(
  state: PluginsMarketplaceState,
  pluginId: string,
) {
  if (!state.client || !state.connected) {
    return false;
  }
  const id = pluginId.trim();
  if (!id) {
    return false;
  }
  state.pluginsMarketplaceActionBusy = "update";
  state.pluginsMarketplaceError = null;
  state.pluginsMarketplaceMessage = null;
  let approveRiskyChanges = false;
  try {
    const preview = await state.client.request<PluginMarketplaceUpdatePreviewResult>(
      "plugins.marketplace.update.preview",
      { id },
    );
    const warningText =
      preview.warnings.length > 0
        ? `\n${preview.warnings.map((warning) => `- ${warning}`).join("\n")}`
        : "";
    state.pluginsMarketplaceMessage = `${preview.message}${warningText}`;
    if (preview.updateReview.approvalRequired) {
      const confirmed =
        typeof globalThis.confirm === "function"
          ? globalThis.confirm(
              [
                `Approve risky update for plugin "${id}"?`,
                "",
                ...preview.updateReview.reasons.map((reason) => `- ${reason}`),
                "",
                "Fased will keep npm scripts ignored and write a review summary to the result panel.",
              ].join("\n"),
            )
          : false;
      if (!confirmed) {
        state.pluginsMarketplaceRemediation = {
          pluginId: preview.pluginId,
          action: "update",
          requiresRestart: false,
          message: "Update review cancelled.",
          warnings: preview.warnings,
          updateReview: preview.updateReview,
        };
        return false;
      }
      approveRiskyChanges = true;
    }
  } catch (err) {
    state.pluginsMarketplaceError = getErrorMessage(err);
    return false;
  } finally {
    state.pluginsMarketplaceActionBusy = null;
  }
  return await mutatePluginMarketplace(
    state,
    "update",
    id,
    approveRiskyChanges ? { approveRiskyChanges: true } : {},
  );
}

export async function restartPluginMarketplaceRuntime(
  state: PluginsMarketplaceState,
  pluginId: string,
) {
  return await mutatePluginMarketplace(state, "restart", pluginId);
}

export async function setPluginMarketplaceSessionHelperGrant(
  state: PluginsMarketplaceState,
  pluginId: string,
  enabled: boolean,
) {
  return await mutatePluginMarketplace(
    state,
    "runtime-helper",
    pluginId,
    {
      helper: "sessions.read",
      enabled,
    },
    { method: "plugins.marketplace.runtimeHelper.set" },
  );
}

export async function setPluginMarketplaceAdminRpcGrant(
  state: PluginsMarketplaceState,
  pluginId: string,
  method: PluginMarketplaceAdminRpcActionMethod,
  enabled: boolean,
) {
  const id = pluginId.trim();
  if (!id) {
    return false;
  }
  if (enabled) {
    const confirmed =
      typeof globalThis.confirm === "function"
        ? globalThis.confirm(
            [
              `Enable admin RPC grant "${method}" for plugin "${id}"?`,
              "",
              "This only grants the fixed wrapper for this method. Calls still need operator approval, source allowlisting, audit logging, and rate limits.",
              "No generic plugin gateway dispatcher is enabled.",
            ].join("\n"),
          )
        : false;
    if (!confirmed) {
      return false;
    }
  }
  return await mutatePluginMarketplace(
    state,
    "admin-rpc-grant",
    id,
    {
      method,
      enabled,
    },
    { method: "plugins.marketplace.adminRpcGrant.set" },
  );
}

export async function uninstallPluginMarketplaceEntry(
  state: PluginsMarketplaceState,
  pluginId: string,
) {
  const id = pluginId.trim();
  if (!id) {
    return false;
  }
  if (typeof window !== "undefined") {
    const confirmed = window.confirm(
      `Uninstall plugin "${id}"?\n\nThis removes its config entry and installed files when safe. A gateway restart is still required to fully unload runtime code.`,
    );
    if (!confirmed) {
      return false;
    }
  }
  return await mutatePluginMarketplace(state, "uninstall", id);
}
