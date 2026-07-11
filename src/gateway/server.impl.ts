import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/runs.js";
import { registerSkillsChangeListener } from "../agents/skills/refresh.js";
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import type { CanvasHostServer } from "../canvas-host/server.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { formatCliCommand } from "../cli/command-format.js";
import { createDefaultDeps } from "../cli/deps.js";
import {
  CONFIG_PATH,
  isNixMode,
  loadConfig,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { clearAgentRunContext, onAgentEvent } from "../infra/agent-events.js";
import {
  ensureControlUiAssetsBuilt,
  resolveControlUiRootOverrideSync,
  resolveControlUiRootSync,
} from "../infra/control-ui-assets.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { logAcceptedEnvOption } from "../infra/env.js";
import { createExecApprovalForwarder } from "../infra/exec-approval-forwarder.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import { startHeartbeatRunner, type HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { ensureFasedAgentCliOnPath } from "../infra/path-env.js";
import { setGatewaySigusr1RestartPolicy, setPreRestartDeferralCheck } from "../infra/restart.js";
import {
  primeRemoteSkillsCache,
  refreshRemoteBinsForConnectedNodes,
  setSkillsRemoteRegistry,
} from "../infra/skills-remote.js";
import { scheduleGatewayUpdateCheck } from "../infra/update-startup.js";
import {
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "../logging/diagnostic-stability.js";
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat } from "../logging/diagnostic.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner, runGlobalGatewayStopSafely } from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import type { RuntimeEnv } from "../runtime.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  createWalletProviderAdapter,
  resolveWalletProviderId,
} from "../wallet/wallet-provider-resolver.js";
import {
  resolveLocalSignerMaterialRootDir,
  resolveWalletRuntimeConfig,
} from "../wallet/wallet-runtime-config.js";
import { runOnboardingWizard } from "../wizard/onboarding.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import { startGatewayConfigReloader } from "./config-reload.js";
import { ControlUiLoginService, resolveControlUiPublicHost } from "./control-ui-login.js";
import type { ControlUiRootState } from "./control-ui.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { NodeRegistry } from "./node-registry.js";
import type { startBrowserControlServerIfEnabled } from "./server-browser.js";
import { createChannelManager } from "./server-channels.js";
import { createAgentEventHandler } from "./server-chat.js";
import { createGatewayCloseHandler } from "./server-close.js";
import { buildGatewayCronService } from "./server-cron.js";
import { startGatewayDiscovery } from "./server-discovery-runtime.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import { GATEWAY_EVENTS, listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";
import { createExecApprovalHandlers } from "./server-methods/exec-approval.js";
import { safeParseJson } from "./server-methods/nodes.helpers.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import { hasConnectedMobileNode } from "./server-mobile-nodes.js";
import { loadGatewayModelCatalog } from "./server-model-catalog.js";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";
import { loadGatewayPlugins } from "./server-plugins.js";
import { createGatewayReloadHandlers } from "./server-reload-handlers.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";
import {
  broadcastSessionLifecycleEvent,
  createTranscriptUpdateBroadcastHandler,
} from "./server-session-events.js";
import { resolveSessionKeyForRun } from "./server-session-key.js";
import { logGatewayStartup } from "./server-startup-log.js";
import { createGatewayStartupTrace } from "./server-startup-trace.js";
import { startGatewaySidecars } from "./server-startup.js";
import { startGatewayTailscaleExposure } from "./server-tailscale.js";
import { createWizardSessionTracker } from "./server-wizard-sessions.js";
import { attachGatewayWsHandlers } from "./server-ws-runtime.js";
import {
  getHealthCache,
  getHealthVersion,
  getPresenceVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "./server/health-state.js";
import { loadGatewayTlsRuntime } from "./server/tls.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./session-event-subscribers.js";

export { __resetModelCatalogCacheForTest } from "./server-model-catalog.js";

ensureFasedAgentCliOnPath();

const log = createSubsystemLogger("gateway");
const logCanvas = log.child("canvas");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logChannels = log.child("channels");
const logBrowser = log.child("browser");
const logHealth = log.child("health");
const logCron = log.child("cron");
const logReload = log.child("reload");
const logHooks = log.child("hooks");
const logPlugins = log.child("plugins");
const logWsControl = log.child("ws");
const gatewayRuntime = runtimeForLogger(log);
const canvasRuntime = runtimeForLogger(logCanvas);

const LOCAL_SIGNER_STARTUP_RECOVERY_TIMEOUT_MS = 2_000;

function hasConfiguredLocalSignerKeystoreMaterial(env: NodeJS.ProcessEnv): boolean {
  for (const [key, rawValue] of Object.entries(env)) {
    if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
      continue;
    }
    if (
      key === "FASED_WALLET_SOLANA_KEYSTORE_PATH" ||
      key.startsWith("FASED_WALLET_SOLANA_KEYSTORE_PATH__")
    ) {
      return true;
    }
  }

  try {
    const materialDir = resolveLocalSignerMaterialRootDir(env);
    if (!fs.existsSync(materialDir)) {
      return false;
    }
    return fs
      .readdirSync(materialDir, { withFileTypes: true })
      .some((entry) => entry.isFile() && /^keystore-solana(?:-.+)?\.v1\.enc$/i.test(entry.name));
  } catch {
    return false;
  }
}

async function ensureLocalSignerReadyAtGatewayStart(cfg: ReturnType<typeof loadConfig>) {
  const effectiveEnv = { ...process.env, ...cfg.env?.vars };
  const providerId = resolveWalletProviderId(cfg, effectiveEnv);
  if (providerId !== "local-socket-signer") {
    return;
  }
  if (!hasConfiguredLocalSignerKeystoreMaterial(effectiveEnv)) {
    log.debug("local signer startup check skipped: no self-hosted signer keystore material found");
    return;
  }
  const wallet = resolveWalletRuntimeConfig(cfg, effectiveEnv);
  const provider = createWalletProviderAdapter({
    cfg,
    wallet,
    env: effectiveEnv,
    providerIdOverride: "local-socket-signer",
  });
  const initialHealth = await provider.health();
  if (initialHealth.ok) {
    return;
  }
  log.warn(`local signer unhealthy at gateway start: ${initialHealth.details ?? "unknown error"}`);
  try {
    const { restartLocalSocketSigner } = await import("../wizard/onboarding.wallet.js");
    const restarted = await Promise.race([
      restartLocalSocketSigner(undefined, effectiveEnv)
        .then(() => true)
        .catch((err) => {
          log.warn(`failed to restart local signer at gateway start: ${String(err)}`);
          return true;
        }),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), LOCAL_SIGNER_STARTUP_RECOVERY_TIMEOUT_MS),
      ),
    ]);
    if (!restarted) {
      log.warn("local signer restart attempt timed out at gateway start; continuing startup");
      return;
    }
  } catch (err) {
    log.warn(`failed to restart local signer at gateway start: ${String(err)}`);
    return;
  }
  const recoveredHealth = await provider.health();
  if (!recoveredHealth.ok) {
    log.warn(
      `local signer still unhealthy after restart attempt: ${recoveredHealth.details ?? "unknown error"}`,
    );
  }
}

export type GatewayServer = {
  close: (opts?: { reason?: string; restartExpectedMs?: number | null }) => Promise<void>;
};

export type GatewayServerOptions = {
  /**
   * Bind address policy for the Gateway WebSocket/HTTP server.
   * - loopback: 127.0.0.1
   * - lan: 0.0.0.0
   * - tailnet: bind only to the Tailscale IPv4 address (100.64.0.0/10)
   * - auto: prefer loopback, else LAN
   */
  bind?: import("../config/config.js").GatewayBindMode;
  /**
   * Advanced override for the bind host, bypassing bind resolution.
   * Prefer `bind` unless you really need a specific address.
   */
  host?: string;
  /**
   * If false, do not serve the browser Control UI.
   * Default: config `gateway.controlUi.enabled` (or true when absent).
   */
  controlUiEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/chat/completions`.
   * Default: config `gateway.http.endpoints.chatCompletions.enabled` (or false when absent).
   */
  openAiChatCompletionsEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/responses` (OpenResponses API).
   * Default: config `gateway.http.endpoints.responses.enabled` (or false when absent).
   */
  openResponsesEnabled?: boolean;
  /**
   * Override gateway auth configuration (merges with config).
   */
  auth?: import("../config/config.js").GatewayAuthConfig;
  /**
   * Override gateway Tailscale exposure configuration (merges with config).
   */
  tailscale?: import("../config/config.js").GatewayTailscaleConfig;
  /**
   * Test-only: allow canvas host startup even when NODE_ENV/VITEST would disable it.
   */
  allowCanvasHostInTests?: boolean;
  /**
   * Test-only: override the onboarding wizard runner.
   */
  wizardRunner?: (
    opts: import("../commands/onboard-types.js").OnboardOptions,
    runtime: import("../runtime.js").RuntimeEnv,
    prompter: import("../wizard/prompts.js").WizardPrompter,
  ) => Promise<void>;
};

export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  const minimalTestGateway =
    process.env.VITEST === "1" && process.env.FASED_TEST_MINIMAL_GATEWAY === "1";

  // Ensure all default port derivations (browser/canvas) see the actual runtime port.
  process.env.FASED_GATEWAY_PORT = String(port);
  logAcceptedEnvOption({
    key: "FASED_RAW_STREAM",
    description: "raw stream logging enabled",
  });
  logAcceptedEnvOption({
    key: "FASED_RAW_STREAM_PATH",
    description: "raw stream log path override",
  });
  const startupTrace = createGatewayStartupTrace({
    live: process.env.FASED_GATEWAY_STARTUP_TRACE === "1",
    liveLogger: log,
  });

  let configSnapshot = await startupTrace.measure("config.read", () => readConfigFileSnapshot());
  if (configSnapshot.legacyIssues.length > 0) {
    if (isNixMode) {
      throw new Error(
        "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
      );
    }
    const { config: migrated, changes } = migrateLegacyConfig(configSnapshot.parsed);
    if (!migrated) {
      throw new Error(
        `Legacy config entries detected but auto-migration failed. Run "${formatCliCommand("fased doctor")}" to migrate.`,
      );
    }
    await startupTrace.measure("config.migrate", () => writeConfigFile(migrated));
    if (changes.length > 0) {
      log.info(
        `gateway: migrated legacy config entries:\n${changes
          .map((entry) => `- ${entry}`)
          .join("\n")}`,
      );
    }
  }

  configSnapshot = await startupTrace.measure("config.validate", () => readConfigFileSnapshot());
  if (configSnapshot.exists && !configSnapshot.valid) {
    const issues =
      configSnapshot.issues.length > 0
        ? configSnapshot.issues
            .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
            .join("\n")
        : "Unknown validation issue.";
    throw new Error(
      `Invalid config at ${configSnapshot.path}.\n${issues}\nRun "${formatCliCommand("fased doctor")}" to repair, then retry.`,
    );
  }

  const autoEnable = applyPluginAutoEnable({ config: configSnapshot.config, env: process.env });
  if (autoEnable.changes.length > 0) {
    try {
      await startupTrace.measure("config.auto-enable", () => writeConfigFile(autoEnable.config));
      log.info(
        `gateway: auto-enabled plugins:\n${autoEnable.changes
          .map((entry) => `- ${entry}`)
          .join("\n")}`,
      );
    } catch (err) {
      log.warn(`gateway: failed to persist plugin auto-enable changes: ${String(err)}`);
    }
  }

  const cfgAtStart = startupTrace.measureSync("config.load", () => loadConfig());
  const diagnosticsEnabled = isDiagnosticsEnabled(cfgAtStart);
  if (diagnosticsEnabled) {
    startDiagnosticStabilityRecorder();
    startDiagnosticHeartbeat();
  }
  setGatewaySigusr1RestartPolicy({ allowExternal: cfgAtStart.commands?.restart === true });
  setPreRestartDeferralCheck(
    () => getTotalQueueSize() + getTotalPendingReplies() + getActiveEmbeddedRunCount(),
  );
  initSubagentRegistry();
  const defaultAgentId = resolveDefaultAgentId(cfgAtStart);
  const defaultWorkspaceDir = resolveAgentWorkspaceDir(cfgAtStart, defaultAgentId);
  const baseMethods = listGatewayMethods();
  const emptyPluginRegistry: PluginRegistry = createEmptyPluginRegistry();
  const managedFastStart =
    process.env.FASED_GATEWAY_MODE === "managed" && process.env.FASED_GATEWAY_FAST_START === "1";
  let pluginRegistry = emptyPluginRegistry;
  let baseGatewayMethods = baseMethods;
  if (!minimalTestGateway && !managedFastStart) {
    const loadedPlugins = await startupTrace.measure("plugins.load", () =>
      loadGatewayPlugins({
        cfg: cfgAtStart,
        workspaceDir: defaultWorkspaceDir,
        log,
        coreGatewayHandlers,
        baseMethods,
      }),
    );
    pluginRegistry = loadedPlugins.pluginRegistry;
    baseGatewayMethods = loadedPlugins.gatewayMethods;
  }
  if (managedFastStart && !minimalTestGateway) {
    log.info(
      "gateway: managed fast start enabled; deferring optional plugin imports until after bind",
    );
  }
  const channelLogs = Object.fromEntries(
    listChannelPlugins().map((plugin) => [plugin.id, logChannels.child(plugin.id)]),
  ) as Record<ChannelId, ReturnType<typeof createSubsystemLogger>>;
  const channelRuntimeEnvs = Object.fromEntries(
    Object.entries(channelLogs).map(([id, logger]) => [id, runtimeForLogger(logger)]),
  ) as Record<ChannelId, RuntimeEnv>;
  const channelMethods = listChannelPlugins().flatMap((plugin) => plugin.gatewayMethods ?? []);
  const gatewayMethods = Array.from(new Set([...baseGatewayMethods, ...channelMethods]));
  const extraGatewayHandlers: GatewayRequestHandlers = {};
  const addGatewayMethods = (methods: string[]) => {
    const seen = new Set(gatewayMethods);
    for (const method of methods) {
      if (seen.has(method)) {
        continue;
      }
      seen.add(method);
      gatewayMethods.push(method);
    }
  };
  const addPluginGatewayHandlers = (handlers: GatewayRequestHandlers) => {
    for (const [method, handler] of Object.entries(handlers)) {
      extraGatewayHandlers[method] = handler;
    }
  };
  addPluginGatewayHandlers(pluginRegistry.gatewayHandlers);
  let pluginServices: PluginServicesHandle | null = null;
  const runtimeConfig = await startupTrace.measure("runtime.config", () =>
    resolveGatewayRuntimeConfig({
      cfg: cfgAtStart,
      port,
      bind: opts.bind,
      host: opts.host,
      controlUiEnabled: opts.controlUiEnabled,
      openAiChatCompletionsEnabled: opts.openAiChatCompletionsEnabled,
      openResponsesEnabled: opts.openResponsesEnabled,
      auth: opts.auth,
      tailscale: opts.tailscale,
    }),
  );
  const {
    bindHost,
    controlUiEnabled,
    openAiChatCompletionsEnabled,
    openResponsesEnabled,
    openResponsesConfig,
    controlUiBasePath,
    controlUiRoot: controlUiRootOverride,
    resolvedAuth,
    tailscaleConfig,
    tailscaleMode,
  } = runtimeConfig;
  for (const warning of runtimeConfig.securityWarnings) {
    log.warn(`gateway: security warning: ${warning}`);
  }
  let hooksConfig = runtimeConfig.hooksConfig;
  const canvasHostEnabled = runtimeConfig.canvasHostEnabled;
  const gatewayTokenForLogin = resolvedAuth.token?.trim() || "";
  const controlUiLoginService = gatewayTokenForLogin
    ? new ControlUiLoginService({ gatewayToken: gatewayTokenForLogin })
    : null;
  const resolvedAuthWithLogin = controlUiLoginService
    ? {
        ...resolvedAuth,
        sessionTokenVerifier: async (params: {
          token: string;
          req?: import("node:http").IncomingMessage;
          trustedProxies?: string[];
        }) => {
          const host = resolveControlUiPublicHost(params.req, params.trustedProxies ?? [], {
            allowLoopbackHttpsOriginFallback: tailscaleMode === "serve",
          });
          if (!host) {
            return { ok: false } as const;
          }
          const result = controlUiLoginService.authorizeSessionToken({
            token: params.token,
            host,
          });
          if (!result.ok) {
            return { ok: false } as const;
          }
          return { ok: true } as const;
        },
      }
    : resolvedAuth;

  // Create auth rate limiter only when explicitly configured.
  const rateLimitConfig = cfgAtStart.gateway?.auth?.rateLimit;
  const authRateLimiter: AuthRateLimiter | undefined = rateLimitConfig
    ? createAuthRateLimiter(rateLimitConfig)
    : undefined;

  let controlUiRootState: ControlUiRootState | undefined;
  await startupTrace.measure("control-ui.root", async () => {
    if (controlUiRootOverride) {
      const resolvedOverride = resolveControlUiRootOverrideSync(controlUiRootOverride);
      const resolvedOverridePath = path.resolve(controlUiRootOverride);
      controlUiRootState = resolvedOverride
        ? { kind: "resolved", path: resolvedOverride }
        : { kind: "invalid", path: resolvedOverridePath };
      if (!resolvedOverride) {
        log.warn(`gateway: controlUi.root not found at ${resolvedOverridePath}`);
      }
    } else if (controlUiEnabled) {
      let resolvedRoot = resolveControlUiRootSync({
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
        cwd: process.cwd(),
      });
      if (!resolvedRoot) {
        if (process.env.FASED_DISABLE_CONTROL_UI_AUTOBUILD === "1") {
          log.warn("gateway: Control UI assets missing; skipping gateway-side UI auto-build.");
        } else {
          const ensureResult = await ensureControlUiAssetsBuilt(gatewayRuntime);
          if (!ensureResult.ok && ensureResult.message) {
            log.warn(`gateway: ${ensureResult.message}`);
          }
          resolvedRoot = resolveControlUiRootSync({
            moduleUrl: import.meta.url,
            argv1: process.argv[1],
            cwd: process.cwd(),
          });
        }
      }
      controlUiRootState = resolvedRoot
        ? { kind: "resolved", path: resolvedRoot }
        : { kind: "missing" };
    }
  });

  const wizardRunner = opts.wizardRunner ?? runOnboardingWizard;
  const { wizardSessions, findRunningWizard, purgeWizardSession } = createWizardSessionTracker();

  const deps = createDefaultDeps();
  let canvasHostServer: CanvasHostServer | null = null;
  const gatewayTls = await startupTrace.measure("tls.load", () =>
    loadGatewayTlsRuntime(cfgAtStart.gateway?.tls, log.child("tls")),
  );
  if (cfgAtStart.gateway?.tls?.enabled && !gatewayTls.enabled) {
    throw new Error(gatewayTls.error ?? "gateway tls: failed to enable");
  }
  const {
    canvasHost,
    httpServer,
    httpServers,
    httpBindHosts,
    wss,
    clients,
    broadcast,
    broadcastToConnIds,
    agentRunSeq,
    dedupe,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
    toolEventRecipients,
  } = await startupTrace.measure("runtime.state", () =>
    createGatewayRuntimeState({
      cfg: cfgAtStart,
      bindHost,
      port,
      controlUiEnabled,
      controlUiBasePath,
      controlUiRoot: controlUiRootState,
      openAiChatCompletionsEnabled,
      openResponsesEnabled,
      openResponsesConfig,
      controlUiLogin: controlUiLoginService
        ? {
            exchangeGrant: (params) => controlUiLoginService.exchangeGrant(params),
            issueSession: (params) => controlUiLoginService.issueSession(params),
            authorizeSessionToken: (params) => controlUiLoginService.authorizeSessionToken(params),
            revokeSessionToken: (params) => controlUiLoginService.revokeSessionToken(params),
          }
        : undefined,
      resolvedAuth: resolvedAuthWithLogin,
      rateLimiter: authRateLimiter,
      gatewayTls,
      hooksConfig: () => hooksConfig,
      pluginRegistry,
      getPluginRegistry: () => pluginRegistry,
      deps,
      canvasRuntime,
      canvasHostEnabled,
      allowCanvasHostInTests: opts.allowCanvasHostInTests,
      logCanvas,
      log,
      logHooks,
      logPlugins,
    }),
  );
  if (managedFastStart && !minimalTestGateway) {
    const loadedPlugins = await startupTrace.measure("plugins.load.deferred", () =>
      loadGatewayPlugins({
        cfg: cfgAtStart,
        workspaceDir: defaultWorkspaceDir,
        log,
        coreGatewayHandlers,
        baseMethods,
      }),
    );
    pluginRegistry = loadedPlugins.pluginRegistry;
    addGatewayMethods(loadedPlugins.gatewayMethods);
    addPluginGatewayHandlers(pluginRegistry.gatewayHandlers);
    const loadedPluginCount = pluginRegistry.plugins.filter(
      (plugin) => plugin.status === "loaded",
    ).length;
    log.info(`gateway: managed fast start loaded deferred plugins (${loadedPluginCount} loaded)`);
  }
  let bonjourStop: (() => Promise<void>) | null = null;
  const nodeRegistry = new NodeRegistry();
  const nodePresenceTimers = new Map<string, ReturnType<typeof setInterval>>();
  const nodeSubscriptions = createNodeSubscriptionManager();
  const sessionEventSubscribers = createSessionEventSubscriberRegistry();
  const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
  const nodeSendEvent = (opts: { nodeId: string; event: string; payloadJSON?: string | null }) => {
    const payload = safeParseJson(opts.payloadJSON ?? null);
    nodeRegistry.sendEvent(opts.nodeId, opts.event, payload);
  };
  const nodeSendToSession = (sessionKey: string, event: string, payload: unknown) =>
    nodeSubscriptions.sendToSession(sessionKey, event, payload, nodeSendEvent);
  const nodeSendToAllSubscribed = (event: string, payload: unknown) =>
    nodeSubscriptions.sendToAllSubscribed(event, payload, nodeSendEvent);
  const nodeSubscribe = nodeSubscriptions.subscribe;
  const nodeUnsubscribe = nodeSubscriptions.unsubscribe;
  const nodeUnsubscribeAll = nodeSubscriptions.unsubscribeAll;
  const subscribeSessionEvents = sessionEventSubscribers.subscribe;
  const unsubscribeSessionEvents = sessionEventSubscribers.unsubscribe;
  const broadcastSessionLifecycle = (params: {
    sessionKey: string | undefined;
    phase: string;
    runId?: string;
    reason?: string;
  }) =>
    broadcastSessionLifecycleEvent({
      broadcastToConnIds,
      sessionEventSubscribers,
      ...params,
    });
  const subscribeSessionMessageEvents = sessionMessageSubscribers.subscribe;
  const unsubscribeSessionMessageEvents = sessionMessageSubscribers.unsubscribe;
  const unsubscribeAllSessionEvents = (connId: string) => {
    sessionEventSubscribers.unsubscribeAll(connId);
    sessionMessageSubscribers.unsubscribeAll(connId);
  };
  const broadcastVoiceWakeChanged = (triggers: string[]) => {
    broadcast("voicewake.changed", { triggers }, { dropIfSlow: true });
    broadcast("voicewake.routing.changed", { triggers }, { dropIfSlow: true });
  };
  const hasMobileNodeConnected = () => hasConnectedMobileNode(nodeRegistry);
  applyGatewayLaneConcurrency(cfgAtStart);

  let cronState = startupTrace.measureSync("cron.build", () =>
    buildGatewayCronService({
      cfg: cfgAtStart,
      deps,
      broadcast,
    }),
  );
  let { cron, storePath: cronStorePath } = cronState;

  const channelManager = createChannelManager({
    loadConfig,
    channelLogs,
    channelRuntimeEnvs,
  });
  const { getRuntimeSnapshot, startChannels, startChannel, stopChannel, markChannelLoggedOut } =
    channelManager;
  const refreshGatewayHealthSnapshotWithRuntime: typeof refreshGatewayHealthSnapshot = (opts) =>
    refreshGatewayHealthSnapshot({
      ...opts,
      getRuntimeSnapshot,
    });

  if (!minimalTestGateway) {
    const discovery = await startupTrace.measure("discovery.start", async () => {
      const machineDisplayName = await getMachineDisplayName();
      return startGatewayDiscovery({
        machineDisplayName,
        port,
        gatewayTls: gatewayTls.enabled
          ? { enabled: true, fingerprintSha256: gatewayTls.fingerprintSha256 }
          : undefined,
        wideAreaDiscoveryEnabled: cfgAtStart.discovery?.wideArea?.enabled === true,
        wideAreaDiscoveryDomain: cfgAtStart.discovery?.wideArea?.domain,
        tailscaleMode,
        mdnsMode: cfgAtStart.discovery?.mdns?.mode,
        logDiscovery,
      });
    });
    bonjourStop = discovery.bonjourStop;
  }

  if (!minimalTestGateway) {
    setSkillsRemoteRegistry(nodeRegistry);
    void primeRemoteSkillsCache();
  }
  // Debounce skills-triggered node probes to avoid feedback loops and rapid-fire invokes.
  // Skills changes can happen in bursts (e.g., file watcher events), and each probe
  // takes time to complete. A 30-second delay ensures we batch changes together.
  let skillsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const skillsRefreshDelayMs = 30_000;
  const skillsChangeUnsub = minimalTestGateway
    ? () => {}
    : registerSkillsChangeListener((event) => {
        if (event.reason === "remote-node") {
          return;
        }
        if (skillsRefreshTimer) {
          clearTimeout(skillsRefreshTimer);
        }
        skillsRefreshTimer = setTimeout(() => {
          skillsRefreshTimer = null;
          const latest = loadConfig();
          void refreshRemoteBinsForConnectedNodes(latest);
        }, skillsRefreshDelayMs);
      });

  const noopInterval = () => setInterval(() => {}, 1 << 30);
  let tickInterval = noopInterval();
  let healthInterval = noopInterval();
  let dedupeCleanup = noopInterval();
  if (!minimalTestGateway) {
    ({ tickInterval, healthInterval, dedupeCleanup } = startupTrace.measureSync(
      "maintenance.start",
      () =>
        startGatewayMaintenanceTimers({
          broadcast,
          nodeSendToAllSubscribed,
          getPresenceVersion,
          getHealthVersion,
          refreshGatewayHealthSnapshot: refreshGatewayHealthSnapshotWithRuntime,
          logHealth,
          dedupe,
          chatAbortControllers,
          chatRunState,
          chatRunBuffers,
          chatDeltaSentAt,
          removeChatRun,
          agentRunSeq,
          nodeSendToSession,
        }),
    ));
  }

  const agentUnsub = minimalTestGateway
    ? null
    : onAgentEvent(
        createAgentEventHandler({
          broadcast,
          broadcastToConnIds,
          nodeSendToSession,
          agentRunSeq,
          chatRunState,
          resolveSessionKeyForRun,
          clearAgentRunContext,
          toolEventRecipients,
          sessionEventSubscribers,
        }),
      );

  const transcriptUnsub = onSessionTranscriptUpdate(
    createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers,
      sessionMessageSubscribers,
    }),
  );

  const heartbeatUnsub = minimalTestGateway
    ? null
    : onHeartbeatEvent((evt) => {
        broadcast("heartbeat", evt, { dropIfSlow: true });
      });

  let heartbeatRunner: HeartbeatRunner = minimalTestGateway
    ? {
        stop: () => {},
        updateConfig: () => {},
      }
    : startHeartbeatRunner({ cfg: cfgAtStart });

  if (!minimalTestGateway) {
    void cron.start().catch((err) => logCron.error(`failed to start: ${String(err)}`));
  }

  // Recover pending outbound deliveries from previous crash/restart.
  if (!minimalTestGateway) {
    void (async () => {
      const { recoverPendingDeliveries } = await import("../infra/outbound/delivery-queue.js");
      const { deliverOutboundPayloads } = await import("../infra/outbound/deliver.js");
      const logRecovery = log.child("delivery-recovery");
      await recoverPendingDeliveries({
        deliver: deliverOutboundPayloads,
        log: logRecovery,
        cfg: cfgAtStart,
      });
    })().catch((err) => log.error(`Delivery recovery failed: ${String(err)}`));
  }

  const execApprovalManager = new ExecApprovalManager();
  const execApprovalForwarder = createExecApprovalForwarder();
  const execApprovalHandlers = createExecApprovalHandlers(execApprovalManager, {
    forwarder: execApprovalForwarder,
  });
  Object.assign(extraGatewayHandlers, execApprovalHandlers);

  const canvasHostServerPort = (canvasHostServer as CanvasHostServer | null)?.port;

  startupTrace.measureSync("ws.attach", () => {
    attachGatewayWsHandlers({
      wss,
      clients,
      port,
      gatewayHost: bindHost ?? undefined,
      canvasHostEnabled: Boolean(canvasHost),
      canvasHostServerPort,
      resolvedAuth: resolvedAuthWithLogin,
      rateLimiter: authRateLimiter,
      gatewayMethods,
      events: GATEWAY_EVENTS,
      logGateway: log,
      logHealth,
      logWsControl,
      extraHandlers: extraGatewayHandlers,
      broadcast,
      context: {
        deps,
        cron,
        cronStorePath,
        execApprovalManager,
        loadGatewayModelCatalog,
        getHealthCache,
        refreshHealthSnapshot: refreshGatewayHealthSnapshotWithRuntime,
        logHealth,
        logGateway: log,
        incrementPresenceVersion,
        getHealthVersion,
        broadcast,
        broadcastToConnIds,
        nodeSendToSession,
        nodeSendToAllSubscribed,
        nodeSubscribe,
        nodeUnsubscribe,
        nodeUnsubscribeAll,
        subscribeSessionEvents,
        unsubscribeSessionEvents,
        broadcastSessionLifecycleEvent: broadcastSessionLifecycle,
        subscribeSessionMessageEvents,
        unsubscribeSessionMessageEvents,
        unsubscribeAllSessionEvents,
        hasConnectedMobileNode: hasMobileNodeConnected,
        nodeRegistry,
        agentRunSeq,
        chatAbortControllers,
        chatAbortedRuns: chatRunState.abortedRuns,
        chatRunBuffers: chatRunState.buffers,
        chatDeltaSentAt: chatRunState.deltaSentAt,
        addChatRun,
        removeChatRun,
        registerToolEventRecipient: toolEventRecipients.add,
        dedupe,
        wizardSessions,
        findRunningWizard,
        purgeWizardSession,
        getRuntimeSnapshot,
        startChannel,
        stopChannel,
        markChannelLoggedOut,
        wizardRunner,
        broadcastVoiceWakeChanged,
      },
    });
  });
  logGatewayStartup({
    cfg: cfgAtStart,
    bindHost,
    bindHosts: httpBindHosts,
    port,
    tlsEnabled: gatewayTls.enabled,
    log,
    isNixMode,
  });
  if (!minimalTestGateway) {
    await startupTrace.measure("local-signer.ready", () =>
      ensureLocalSignerReadyAtGatewayStart(cfgAtStart),
    );
  }
  if (!minimalTestGateway) {
    scheduleGatewayUpdateCheck({ cfg: cfgAtStart, log, isNixMode });
  }
  const tailscaleCleanup = minimalTestGateway
    ? null
    : await startupTrace.measure("tailscale.start", () =>
        startGatewayTailscaleExposure({
          tailscaleMode,
          resetOnExit: tailscaleConfig.resetOnExit,
          port,
          controlUiBasePath,
          logTailscale,
        }),
      );

  let browserControl: Awaited<ReturnType<typeof startBrowserControlServerIfEnabled>> = null;
  let federationAutoConnect: ReturnType<
    typeof import("../federation/auto-connect.js").startFederationAutoConnect
  > = null;
  if (!minimalTestGateway) {
    const sidecars = await startupTrace.measure("sidecars.start", () =>
      startGatewaySidecars({
        cfg: cfgAtStart,
        pluginRegistry,
        defaultWorkspaceDir,
        deps,
        startChannels,
        log,
        logHooks,
        logChannels,
        logBrowser,
      }),
    );
    browserControl = sidecars.browserControl;
    pluginServices = sidecars.pluginServices;
    federationAutoConnect = sidecars.federationAutoConnect;
  }

  // Run gateway_start plugin hook (fire-and-forget)
  if (!minimalTestGateway) {
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks("gateway_start")) {
      void hookRunner.runGatewayStart({ port }, { port }).catch((err) => {
        log.warn(`gateway_start hook failed: ${String(err)}`);
      });
    }
  }

  const configReloader = minimalTestGateway
    ? { stop: async () => {} }
    : startupTrace.measureSync("config-reload.start", () => {
        const { applyHotReload, requestGatewayRestart } = createGatewayReloadHandlers({
          deps,
          broadcast,
          getState: () => ({
            hooksConfig,
            heartbeatRunner,
            cronState,
            browserControl,
          }),
          setState: (nextState) => {
            hooksConfig = nextState.hooksConfig;
            heartbeatRunner = nextState.heartbeatRunner;
            cronState = nextState.cronState;
            cron = cronState.cron;
            cronStorePath = cronState.storePath;
            browserControl = nextState.browserControl;
          },
          startChannel,
          stopChannel,
          logHooks,
          logBrowser,
          logChannels,
          logCron,
          logReload,
        });

        return startGatewayConfigReloader({
          initialConfig: cfgAtStart,
          readSnapshot: readConfigFileSnapshot,
          onHotReload: applyHotReload,
          onRestart: requestGatewayRestart,
          log: {
            info: (msg) => logReload.info(msg),
            warn: (msg) => logReload.warn(msg),
            error: (msg) => logReload.error(msg),
          },
          watchPath: CONFIG_PATH,
        });
      });

  startupTrace.logSummary(log);

  const close = createGatewayCloseHandler({
    bonjourStop,
    tailscaleCleanup,
    canvasHost,
    canvasHostServer,
    stopChannel,
    pluginServices,
    cron,
    heartbeatRunner,
    nodePresenceTimers,
    broadcast,
    tickInterval,
    healthInterval,
    dedupeCleanup,
    agentUnsub,
    heartbeatUnsub,
    chatRunState,
    clients,
    configReloader,
    browserControl,
    wss,
    httpServer,
    httpServers,
    onClose: [
      async () => {
        federationAutoConnect?.stop();
      },
      () => {
        transcriptUnsub?.();
      },
    ],
  });

  return {
    close: async (opts) => {
      // Run gateway_stop plugin hook before shutdown
      await runGlobalGatewayStopSafely({
        event: { reason: opts?.reason ?? "gateway stopping" },
        ctx: { port },
        onError: (err) => log.warn(`gateway_stop hook failed: ${String(err)}`),
      });
      if (diagnosticsEnabled) {
        stopDiagnosticHeartbeat();
        stopDiagnosticStabilityRecorder();
      }
      if (skillsRefreshTimer) {
        clearTimeout(skillsRefreshTimer);
        skillsRefreshTimer = null;
      }
      skillsChangeUnsub();
      authRateLimiter?.dispose();
      await close(opts);
    },
  };
}
