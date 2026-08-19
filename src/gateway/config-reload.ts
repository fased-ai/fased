import { isDeepStrictEqual } from "node:util";
import chokidar from "chokidar";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import type { FasedAgentConfig, ConfigFileSnapshot, GatewayReloadMode } from "../config/config.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { isPlainObject } from "../utils.js";

export type GatewayReloadSettings = {
  mode: GatewayReloadMode;
  debounceMs: number;
};

export type ChannelKind = ChannelId;

export type GatewayReloadPlan = {
  changedPaths: string[];
  restartGateway: boolean;
  restartReasons: string[];
  hotReasons: string[];
  reloadHooks: boolean;
  restartGmailWatcher: boolean;
  restartBrowserControl: boolean;
  restartCron: boolean;
  restartHeartbeat: boolean;
  restartChannels: Set<ChannelKind>;
  noopPaths: string[];
};

type ReloadRule = {
  prefix: string;
  kind: "restart" | "hot" | "none";
  actions?: ReloadAction[];
};

type ReloadAction =
  | "reload-hooks"
  | "restart-gmail-watcher"
  | "restart-browser-control"
  | "restart-cron"
  | "restart-heartbeat"
  | `restart-channel:${ChannelId}`;

const DEFAULT_RELOAD_SETTINGS: GatewayReloadSettings = {
  mode: "hybrid",
  debounceMs: 300,
};
const MISSING_CONFIG_RETRY_DELAY_MS = 150;
const MISSING_CONFIG_MAX_RETRIES = 2;
const WALLET_RPC_ENV_PATH_PREFIXES = [
  "env.vars.FASED_WALLET_SOLANA_RPC_URL",
  "env.vars.FASED_WALLET_RPC_URL",
] as const;
const LOCAL_SIGNER_CONFIG_ENV_PATHS = new Set([
  "env.vars.FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET",
  "env.vars.FASED_WALLET_LOCAL_SIGNER_STATE_DB",
  "env.vars.FASED_WALLET_LOCAL_SIGNER_MASTER_KEY",
]);

const BASE_RELOAD_RULES: ReloadRule[] = [
  { prefix: "gateway.remote", kind: "none" },
  { prefix: "gateway.reload", kind: "none" },
  { prefix: "hooks.gmail", kind: "hot", actions: ["restart-gmail-watcher"] },
  { prefix: "hooks", kind: "hot", actions: ["reload-hooks"] },
  {
    prefix: "agents.defaults.heartbeat",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  { prefix: "agent.heartbeat", kind: "hot", actions: ["restart-heartbeat"] },
  { prefix: "cron", kind: "hot", actions: ["restart-cron"] },
  {
    prefix: "browser",
    kind: "hot",
    actions: ["restart-browser-control"],
  },
];

const BASE_RELOAD_RULES_TAIL: ReloadRule[] = [
  { prefix: "meta", kind: "none" },
  { prefix: "identity", kind: "none" },
  { prefix: "wizard", kind: "none" },
  { prefix: "logging", kind: "none" },
  { prefix: "models", kind: "none" },
  { prefix: "agents", kind: "none" },
  { prefix: "tools", kind: "none" },
  { prefix: "bindings", kind: "none" },
  { prefix: "audio", kind: "none" },
  { prefix: "agent", kind: "none" },
  { prefix: "routing", kind: "none" },
  { prefix: "messages", kind: "none" },
  { prefix: "session", kind: "none" },
  { prefix: "talk", kind: "none" },
  { prefix: "skills", kind: "none" },
  { prefix: "federation", kind: "none" },
  { prefix: "secrets", kind: "none" },
  { prefix: "plugins.entries.sat-mining", kind: "none" },
  { prefix: "plugins", kind: "restart" },
  { prefix: "ui", kind: "none" },
  { prefix: "gateway", kind: "restart" },
  { prefix: "discovery", kind: "restart" },
  { prefix: "canvasHost", kind: "restart" },
];

let cachedReloadRules: ReloadRule[] | null = null;
let cachedRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

function listReloadRules(): ReloadRule[] {
  const registry = getActivePluginRegistry();
  if (registry !== cachedRegistry) {
    cachedReloadRules = null;
    cachedRegistry = registry;
  }
  if (cachedReloadRules) {
    return cachedReloadRules;
  }
  // Channel docking: plugins contribute hot reload/no-op prefixes here.
  const channelReloadRules: ReloadRule[] = listChannelPlugins().flatMap((plugin) => [
    ...(plugin.reload?.configPrefixes ?? []).map(
      (prefix): ReloadRule => ({
        prefix,
        kind: "hot",
        actions: [`restart-channel:${plugin.id}` as ReloadAction],
      }),
    ),
    ...(plugin.reload?.noopPrefixes ?? []).map(
      (prefix): ReloadRule => ({
        prefix,
        kind: "none",
      }),
    ),
  ]);
  const rules = [...BASE_RELOAD_RULES, ...channelReloadRules, ...BASE_RELOAD_RULES_TAIL];
  cachedReloadRules = rules;
  return rules;
}

function matchRule(path: string): ReloadRule | null {
  // These values configure the separately managed signer process and are also
  // materialized when Wallet Create writes signer.env. The Gateway does not
  // need to restart when they are added; doing so disconnects the very request
  // that created the wallet.
  if (LOCAL_SIGNER_CONFIG_ENV_PATHS.has(path)) {
    return { prefix: path, kind: "none" };
  }
  const walletRpcPrefix = WALLET_RPC_ENV_PATH_PREFIXES.find(
    (prefix) => path === prefix || path.startsWith(`${prefix}__`),
  );
  if (walletRpcPrefix) {
    return { prefix: walletRpcPrefix, kind: "none" };
  }
  for (const rule of listReloadRules()) {
    if (path === rule.prefix || path.startsWith(`${rule.prefix}.`)) {
      return rule;
    }
  }
  return null;
}

export function diffConfigPaths(prev: unknown, next: unknown, prefix = ""): string[] {
  if (prev === next) {
    return [];
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const paths: string[] = [];
    for (const key of keys) {
      const prevValue = prev[key];
      const nextValue = next[key];
      if (prevValue === undefined && nextValue === undefined) {
        continue;
      }
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      const childPaths = diffConfigPaths(prevValue, nextValue, childPrefix);
      if (childPaths.length > 0) {
        paths.push(...childPaths);
      }
    }
    return paths;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    // Arrays can contain object entries (for example memory.qmd.paths/scope.rules);
    // compare structurally so identical values are not reported as changed.
    if (isDeepStrictEqual(prev, next)) {
      return [];
    }
  }
  return [prefix || "<root>"];
}

export function resolveGatewayReloadSettings(cfg: FasedAgentConfig): GatewayReloadSettings {
  const rawMode = cfg.gateway?.reload?.mode;
  const mode =
    rawMode === "off" || rawMode === "restart" || rawMode === "hot" || rawMode === "hybrid"
      ? rawMode
      : DEFAULT_RELOAD_SETTINGS.mode;
  const debounceRaw = cfg.gateway?.reload?.debounceMs;
  const debounceMs =
    typeof debounceRaw === "number" && Number.isFinite(debounceRaw)
      ? Math.max(0, Math.floor(debounceRaw))
      : DEFAULT_RELOAD_SETTINGS.debounceMs;
  return { mode, debounceMs };
}

export function buildGatewayReloadPlan(changedPaths: string[]): GatewayReloadPlan {
  const plan: GatewayReloadPlan = {
    changedPaths,
    restartGateway: false,
    restartReasons: [],
    hotReasons: [],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartBrowserControl: false,
    restartCron: false,
    restartHeartbeat: false,
    restartChannels: new Set(),
    noopPaths: [],
  };

  const applyAction = (action: ReloadAction) => {
    if (action.startsWith("restart-channel:")) {
      const channel = action.slice("restart-channel:".length) as ChannelId;
      plan.restartChannels.add(channel);
      return;
    }
    switch (action) {
      case "reload-hooks":
        plan.reloadHooks = true;
        break;
      case "restart-gmail-watcher":
        plan.restartGmailWatcher = true;
        break;
      case "restart-browser-control":
        plan.restartBrowserControl = true;
        break;
      case "restart-cron":
        plan.restartCron = true;
        break;
      case "restart-heartbeat":
        plan.restartHeartbeat = true;
        break;
      default:
        break;
    }
  };

  for (const path of changedPaths) {
    const rule = matchRule(path);
    if (!rule) {
      plan.restartGateway = true;
      plan.restartReasons.push(path);
      continue;
    }
    if (rule.kind === "restart") {
      plan.restartGateway = true;
      plan.restartReasons.push(path);
      continue;
    }
    if (rule.kind === "none") {
      plan.noopPaths.push(path);
      continue;
    }
    plan.hotReasons.push(path);
    for (const action of rule.actions ?? []) {
      applyAction(action);
    }
  }

  if (plan.restartGmailWatcher) {
    plan.reloadHooks = true;
  }

  return plan;
}

export type GatewayConfigReloader = {
  stop: () => Promise<void>;
};

export function startGatewayConfigReloader(opts: {
  initialConfig: FasedAgentConfig;
  readSnapshot: () => Promise<ConfigFileSnapshot>;
  onHotReload: (
    plan: GatewayReloadPlan,
    nextConfig: FasedAgentConfig,
    snapshot: ConfigFileSnapshot,
  ) => Promise<void>;
  onRestart: (
    plan: GatewayReloadPlan,
    nextConfig: FasedAgentConfig,
    snapshot: ConfigFileSnapshot,
  ) => void | Promise<void>;
  onSourceRevision?: (snapshot: ConfigFileSnapshot) => void;
  onStop?: () => void;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  watchPath: string;
}): GatewayConfigReloader {
  let currentConfig = opts.initialConfig;
  let settings = resolveGatewayReloadSettings(currentConfig);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let running = false;
  let stopped = false;
  let missingConfigRetries = 0;
  let activeRun: Promise<void> | null = null;

  const scheduleAfter = (wait: number) => {
    if (stopped) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      void runReload();
    }, wait);
  };
  const schedule = () => {
    scheduleAfter(settings.debounceMs);
  };
  const queueRestart = async (
    plan: GatewayReloadPlan,
    nextConfig: FasedAgentConfig,
    snapshot: ConfigFileSnapshot,
  ): Promise<boolean> => {
    try {
      await opts.onRestart(plan, nextConfig, snapshot);
      return true;
    } catch {
      // Restart checks can fail (for example unresolved SecretRefs). Keep the
      // active-runtime baseline and allow an unchanged source revision to retry.
      opts.log.error("config restart validation failed; restart was not scheduled");
      return false;
    }
  };

  const handleMissingSnapshot = (snapshot: ConfigFileSnapshot): boolean => {
    if (snapshot.exists) {
      missingConfigRetries = 0;
      return false;
    }
    if (missingConfigRetries < MISSING_CONFIG_MAX_RETRIES) {
      missingConfigRetries += 1;
      opts.log.info(
        `config reload retry (${missingConfigRetries}/${MISSING_CONFIG_MAX_RETRIES}): config file not found`,
      );
      scheduleAfter(MISSING_CONFIG_RETRY_DELAY_MS);
      return true;
    }
    opts.log.warn("config reload skipped (config file not found)");
    return true;
  };

  const handleInvalidSnapshot = (snapshot: ConfigFileSnapshot): boolean => {
    if (snapshot.valid) {
      return false;
    }
    const issues = snapshot.issues.map((issue) => `${issue.path}: ${issue.message}`).join(", ");
    opts.log.warn(`config reload skipped (invalid config): ${issues}`);
    return true;
  };

  const applySnapshot = async (snapshot: ConfigFileSnapshot) => {
    const nextConfig = snapshot.config;
    const changedPaths = diffConfigPaths(currentConfig, nextConfig);
    const nextSettings = resolveGatewayReloadSettings(nextConfig);
    const commitBaseline = () => {
      currentConfig = nextConfig;
      settings = nextSettings;
    };
    if (changedPaths.length === 0) {
      commitBaseline();
      return;
    }

    opts.log.info(`config change detected; evaluating reload (${changedPaths.join(", ")})`);
    const plan = buildGatewayReloadPlan(changedPaths);
    if (nextSettings.mode === "off") {
      opts.log.info("config reload disabled (gateway.reload.mode=off)");
      return;
    }
    if (nextSettings.mode === "restart") {
      await queueRestart(plan, nextConfig, snapshot);
      return;
    }
    if (plan.restartGateway) {
      if (nextSettings.mode === "hot") {
        opts.log.warn(
          `config reload requires gateway restart; hot mode ignoring (${plan.restartReasons.join(
            ", ",
          )})`,
        );
        return;
      }
      await queueRestart(plan, nextConfig, snapshot);
      return;
    }

    await opts.onHotReload(plan, nextConfig, snapshot);
    commitBaseline();
  };

  const runReload = (): Promise<void> => {
    if (stopped) {
      return Promise.resolve();
    }
    if (running) {
      pending = true;
      return activeRun ?? Promise.resolve();
    }
    const run = (async () => {
      running = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      try {
        const snapshot = await opts.readSnapshot();
        // A newly observed source revision supersedes any decision made for the
        // previous one, even when this revision is missing, invalid, unchanged,
        // disabled, or cannot be applied in the configured reload mode.
        opts.onSourceRevision?.(snapshot);
        if (handleMissingSnapshot(snapshot)) {
          return;
        }
        if (handleInvalidSnapshot(snapshot)) {
          return;
        }
        await applySnapshot(snapshot);
      } catch {
        opts.log.error("config reload failed; keeping last-known-good configuration");
      } finally {
        running = false;
        if (pending) {
          pending = false;
          schedule();
        }
      }
    })();
    activeRun = run;
    void run.finally(() => {
      if (activeRun === run) {
        activeRun = null;
      }
    });
    return run;
  };

  const watcher = chokidar.watch(opts.watchPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    usePolling: Boolean(process.env.VITEST),
  });

  watcher.on("add", schedule);
  watcher.on("change", schedule);
  watcher.on("unlink", schedule);
  let watcherClosed = false;
  watcher.on("error", (err) => {
    if (watcherClosed) {
      return;
    }
    watcherClosed = true;
    opts.log.warn(`config watcher error: ${String(err)}`);
    void watcher.close().catch(() => {});
  });

  let stopPromise: Promise<void> | null = null;

  return {
    stop: () => {
      if (stopPromise) {
        return stopPromise;
      }
      stopPromise = (async () => {
        stopped = true;
        pending = false;
        try {
          opts.onStop?.();
        } catch {
          opts.log.warn("config reload shutdown cleanup failed");
        }
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = null;
        watcherClosed = true;
        await watcher.close().catch(() => {});
        await activeRun;
      })();
      return stopPromise;
    },
  };
}
