import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import type { CliDeps } from "../cli/deps.js";
import type { loadConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { loadFasedAgentPlugins } from "../plugins/loader.js";
import { type PluginServicesHandle } from "../plugins/services.js";
import {
  scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel,
} from "./server-restart-sentinel.js";
import {
  areChannelsConfigured,
  areInternalHooksConfigured,
  isFederationAutoConnectConfigured,
  isGmailWatcherConfigured,
  isOptionalMemoryBackendConfigured,
  isSelectedModelConfigured,
} from "./startup-selection.js";

async function prewarmConfiguredPrimaryModel(params: {
  cfg: ReturnType<typeof loadConfig>;
  log: { warn: (msg: string) => void };
}): Promise<void> {
  const explicitPrimary = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model)?.trim();
  if (!explicitPrimary) {
    return;
  }
  let resolvedRefLabel = explicitPrimary;
  try {
    const [
      { resolveFasedAgentDir },
      { ensureFasedModelsJson },
      { resolveConfiguredModelRef },
      { resolveModel },
    ] = await Promise.all([
      import("../agents/agent-paths.js"),
      import("../agents/models-config.js"),
      import("../agents/model-selection.js"),
      import("../agents/pi-embedded-runner/model.js"),
    ]);
    const agentDir = resolveFasedAgentDir();
    await ensureFasedModelsJson(params.cfg, agentDir);
    const { provider, model } = resolveConfiguredModelRef({
      cfg: params.cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    resolvedRefLabel = `${provider}/${model}`;
    const resolved = resolveModel(provider, model, agentDir, params.cfg);
    if (!resolved.model) {
      throw new Error(resolved.error ?? `Unknown model: ${provider}/${model}`);
    }
  } catch (err) {
    params.log.warn(`startup model warmup failed for ${resolvedRefLabel}: ${String(err)}`);
  }
}

export async function startGatewaySidecars(params: {
  cfg: ReturnType<typeof loadConfig>;
  pluginRegistry: ReturnType<typeof loadFasedAgentPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
}) {
  // Start Gmail watcher if configured (hooks.gmail.account).
  // Dynamically imported — only loads the Gmail SDK when actually needed.
  if (
    isGmailWatcherConfigured(params.cfg) &&
    !isTruthyEnvValue(process.env.FASED_SKIP_GMAIL_WATCHER)
  ) {
    try {
      const { startGmailWatcher } = await import("../hooks/gmail-watcher.js");
      const gmailResult = await startGmailWatcher(params.cfg);
      if (gmailResult.started) {
        params.logHooks.info("gmail watcher started");
      } else if (gmailResult.reason) {
        params.logHooks.warn(`gmail watcher not started: ${gmailResult.reason}`);
      }
    } catch (err) {
      params.logHooks.error(`gmail watcher failed to start: ${String(err)}`);
    }
  }

  // Validate hooks.gmail.model if configured.
  // Dynamically imported — model catalog is large; only load when a custom model is set.
  if (isGmailWatcherConfigured(params.cfg) && params.cfg.hooks?.gmail?.model) {
    try {
      const { DEFAULT_MODEL, DEFAULT_PROVIDER } = await import("../agents/defaults.js");
      const { loadModelCatalog } = await import("../agents/model-catalog.js");
      const { getModelRefStatus, resolveConfiguredModelRef, resolveHooksGmailModel } =
        await import("../agents/model-selection.js");
      const hooksModelRef = resolveHooksGmailModel({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
      });
      if (hooksModelRef) {
        const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
          cfg: params.cfg,
          defaultProvider: DEFAULT_PROVIDER,
          defaultModel: DEFAULT_MODEL,
        });
        const catalog = await loadModelCatalog({ config: params.cfg });
        const status = getModelRefStatus({
          cfg: params.cfg,
          catalog,
          ref: hooksModelRef,
          defaultProvider,
          defaultModel,
        });
        if (!status.allowed) {
          params.logHooks.warn(
            `hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`,
          );
        }
        if (!status.inCatalog) {
          params.logHooks.warn(
            `hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
          );
        }
      }
    } catch (err) {
      params.logHooks.error(`gmail model validation failed: ${String(err)}`);
    }
  }

  // Load internal hook handlers from configuration and directory discovery.
  // Dynamically imported — hook loader reads the filesystem and may pull in SDK code.
  if (areInternalHooksConfigured(params.cfg)) {
    const capturedCfg = params.cfg;
    const capturedDeps = params.deps;
    const capturedWorkspaceDir = params.defaultWorkspaceDir;
    try {
      const [internalHooks, hookLoader] = await Promise.all([
        import("../hooks/internal-hooks.js"),
        import("../hooks/loader.js"),
      ]);
      internalHooks.clearInternalHooks();
      const loadedCount = await hookLoader.loadInternalHooks(capturedCfg, capturedWorkspaceDir);
      if (loadedCount > 0) {
        params.logHooks.info(
          `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
        );
        setTimeout(() => {
          const hookEvent = internalHooks.createInternalHookEvent(
            "gateway",
            "startup",
            "gateway:startup",
            {
              cfg: capturedCfg,
              deps: capturedDeps,
              workspaceDir: capturedWorkspaceDir,
            },
          );
          void internalHooks.triggerInternalHook(hookEvent);
        }, 250);
      }
    } catch (err) {
      params.logHooks.error(`failed to load hooks: ${String(err)}`);
    }
  }

  // Launch configured channels so gateway replies via the surface the message came from.
  // Tests can opt out via FASED_SKIP_CHANNELS (or legacy FASED_SKIP_PROVIDERS).
  const skipChannels =
    isTruthyEnvValue(process.env.FASED_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.FASED_SKIP_PROVIDERS);
  const startConfiguredChannels = areChannelsConfigured(params.cfg);
  const warmSelectedModel = isSelectedModelConfigured(params.cfg);
  if (!skipChannels && (startConfiguredChannels || warmSelectedModel)) {
    try {
      if (warmSelectedModel) {
        await prewarmConfiguredPrimaryModel({ cfg: params.cfg, log: params.log });
      }
      if (startConfiguredChannels) {
        await params.startChannels();
      }
    } catch (err) {
      params.logChannels.error(`channel startup failed: ${String(err)}`);
    }
  } else if (skipChannels) {
    params.logChannels.info(
      "skipping channel start (FASED_SKIP_CHANNELS=1 or FASED_SKIP_PROVIDERS=1)",
    );
  } else {
    params.logChannels.info("no configured channels; skipping channel startup");
  }

  // Start plugin services — dynamically imported; only meaningful when plugins are registered.
  let pluginServices: PluginServicesHandle | null = null;
  if (params.pluginRegistry.services.length > 0) {
    try {
      const { startPluginServices } = await import("../plugins/services.js");
      pluginServices = await startPluginServices({
        registry: params.pluginRegistry,
        config: params.cfg,
        workspaceDir: params.defaultWorkspaceDir,
      });
    } catch (err) {
      params.log.warn(`plugin services failed to start: ${String(err)}`);
    }
  }

  // Start QMD memory backend — dynamically imported; only loads if memory backend is configured.
  if (isOptionalMemoryBackendConfigured(params.cfg)) {
    try {
      const { startGatewayMemoryBackend } = await import("./server-startup-memory.js");
      await startGatewayMemoryBackend({ cfg: params.cfg, log: params.log });
    } catch (err) {
      params.log.warn(`qmd memory startup initialization failed: ${String(err)}`);
    }
  }

  if (shouldWakeFromRestartSentinel()) {
    setTimeout(() => {
      void scheduleRestartSentinelWake({ deps: params.deps });
    }, 750);
  }

  const federationAutoConnect = isFederationAutoConnectConfigured(process.env)
    ? (await import("../federation/auto-connect.js")).startFederationAutoConnect({
        env: process.env,
        log: {
          info: (msg) => params.log.info(msg),
          warn: (msg) => params.log.warn(msg),
          error: (msg) => params.log.error(msg),
        },
      })
    : null;

  return { pluginServices, federationAutoConnect };
}

export const __testing = {
  prewarmConfiguredPrimaryModel,
};
