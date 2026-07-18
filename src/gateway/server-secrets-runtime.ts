import { isDeepStrictEqual } from "node:util";
import type { ConfigFileSnapshot, FasedAgentConfig } from "../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  buildGatewayReloadPlan,
  diffConfigPaths,
  resolveGatewayReloadSettings,
  type GatewayReloadPlan,
} from "./config-reload.js";

type SecretsRuntimeLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type GatewaySecretsRuntimeErrorCode =
  | "SECRETS_CONFIG_INVALID"
  | "SECRETS_CONFIG_MISSING"
  | "SECRETS_HOT_APPLY_FAILED"
  | "SECRETS_RELOAD_FAILED"
  | "SECRETS_RESOLUTION_FAILED"
  | "SECRETS_RUNTIME_CLOSED"
  | "SECRETS_SOURCE_HOT_RELOAD_REQUIRED"
  | "SECRETS_SOURCE_RESTART_REQUIRED"
  | "SECRETS_SOURCE_STALE";

export type SanitizedGatewaySecretsRuntimeError = {
  code: GatewaySecretsRuntimeErrorCode;
  message: string;
};

export type GatewaySecretsHotReloadTransaction = {
  apply: (config: FasedAgentConfig) => Promise<void>;
  rollback: (config: FasedAgentConfig) => Promise<void>;
};

export class GatewaySecretsRuntimeError extends Error {
  readonly code: GatewaySecretsRuntimeErrorCode;

  constructor(
    code: GatewaySecretsRuntimeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GatewaySecretsRuntimeError";
    this.code = code;
  }
}

export function sanitizeGatewaySecretsRuntimeError(
  error: unknown,
): SanitizedGatewaySecretsRuntimeError {
  if (error instanceof GatewaySecretsRuntimeError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "SECRETS_RELOAD_FAILED",
    message:
      "Secret reload failed without changing the active runtime snapshot. Run `fased secrets audit --check` for local diagnostics.",
  };
}

function runtimeError(
  code: GatewaySecretsRuntimeErrorCode,
  message: string,
  cause?: unknown,
): GatewaySecretsRuntimeError {
  return new GatewaySecretsRuntimeError(code, message, cause === undefined ? undefined : { cause });
}

function normalizeRuntimeError(
  error: unknown,
  fallbackCode: GatewaySecretsRuntimeErrorCode,
  fallbackMessage: string,
): GatewaySecretsRuntimeError {
  return error instanceof GatewaySecretsRuntimeError
    ? error
    : runtimeError(fallbackCode, fallbackMessage, error);
}

function invalidSnapshotError(snapshot: ConfigFileSnapshot): GatewaySecretsRuntimeError {
  const paths = [...new Set(snapshot.issues.map((issue) => issue.path.trim() || "<root>"))].slice(
    0,
    8,
  );
  const suffix = paths.length > 0 ? ` Invalid paths: ${paths.join(", ")}.` : "";
  return runtimeError(
    "SECRETS_CONFIG_INVALID",
    `Secret reload refused an invalid Gateway config.${suffix} Run \`fased doctor\` locally before retrying.`,
  );
}

function missingSnapshotError(): GatewaySecretsRuntimeError {
  return runtimeError(
    "SECRETS_CONFIG_MISSING",
    "Secret reload refused to replace the active snapshot because the Gateway config file is missing.",
  );
}

function staleSourceError(): GatewaySecretsRuntimeError {
  return runtimeError(
    "SECRETS_SOURCE_STALE",
    "Secret reload discarded a stale config revision; retry after the current config change finishes.",
  );
}

function cloneConfig(config: FasedAgentConfig): FasedAgentConfig {
  return structuredClone(config);
}

function sameSourceSnapshot(left: ConfigFileSnapshot, right: ConfigFileSnapshot): boolean {
  if (left.exists !== right.exists || left.valid !== right.valid) {
    return false;
  }
  if (left.hash && right.hash) {
    return left.hash === right.hash;
  }
  return isDeepStrictEqual(left.config, right.config);
}

function planNeedsHotApply(plan: GatewayReloadPlan): boolean {
  return (
    plan.hotReasons.length > 0 ||
    plan.reloadHooks ||
    plan.restartGmailWatcher ||
    plan.restartBrowserControl ||
    plan.restartCron ||
    plan.restartHeartbeat ||
    plan.restartChannels.size > 0
  );
}

function assertManualSourceChangeAllowed(params: {
  previous: FasedAgentConfig;
  next: FasedAgentConfig;
}): void {
  const changedPaths = diffConfigPaths(params.previous, params.next);
  if (changedPaths.length === 0) {
    return;
  }
  const plan = buildGatewayReloadPlan(changedPaths);
  const settings = resolveGatewayReloadSettings(params.next);
  if (settings.mode === "restart" || plan.restartGateway) {
    throw runtimeError(
      "SECRETS_SOURCE_RESTART_REQUIRED",
      "Secret reload refused config changes that require a Gateway restart. Let the config reloader restart the Gateway, then retry.",
    );
  }
  if (planNeedsHotApply(plan)) {
    throw runtimeError(
      "SECRETS_SOURCE_HOT_RELOAD_REQUIRED",
      "Secret reload refused config changes that require live component reconfiguration. Let the config reloader apply them, then retry.",
    );
  }
}

export function createGatewaySecretsRuntimeController(params: {
  readConfigSnapshot: () => Promise<ConfigFileSnapshot>;
  log: SecretsRuntimeLog;
  prepareSnapshot?: (params: {
    config: FasedAgentConfig;
  }) => Promise<PreparedSecretsRuntimeSnapshot>;
  activateSnapshot?: (snapshot: PreparedSecretsRuntimeSnapshot) => void;
  getActiveSnapshot?: () => PreparedSecretsRuntimeSnapshot | null;
  clearSnapshot?: () => void;
  emitTransition?: (code: "SECRETS_RELOADER_DEGRADED" | "SECRETS_RELOADER_RECOVERED") => void;
}) {
  const prepareSnapshot = params.prepareSnapshot ?? prepareSecretsRuntimeSnapshot;
  const activateSnapshot = params.activateSnapshot ?? activateSecretsRuntimeSnapshot;
  const getActiveSnapshot = params.getActiveSnapshot ?? getActiveSecretsRuntimeSnapshot;
  const clearSnapshot = params.clearSnapshot ?? clearSecretsRuntimeSnapshot;

  let activeSourceConfig: FasedAgentConfig | null = null;
  let degraded = false;
  let closed = false;
  let latestGeneration = 0;
  let operationTail: Promise<void> = Promise.resolve();
  let shutdownPromise: Promise<void> | null = null;

  const runExclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const runTracked = <T>(operation: (generation: number) => Promise<T>): Promise<T> => {
    const generation = ++latestGeneration;
    return runExclusive(async () => await operation(generation));
  };

  const assertCurrent = (generation: number): void => {
    if (closed) {
      throw runtimeError(
        "SECRETS_RUNTIME_CLOSED",
        "Secret reload was cancelled because the Gateway is shutting down.",
      );
    }
    if (generation !== latestGeneration) {
      throw staleSourceError();
    }
  };

  const emitTransition = (code: "SECRETS_RELOADER_DEGRADED" | "SECRETS_RELOADER_RECOVERED") => {
    if (params.emitTransition) {
      params.emitTransition(code);
      return;
    }
    const text =
      code === "SECRETS_RELOADER_DEGRADED"
        ? `[${code}] Secret reload failed; the Gateway kept its last-known-good runtime snapshot.`
        : `[${code}] Secret references recovered and the Gateway activated a new runtime snapshot.`;
    enqueueSystemEvent(text, {
      sessionKey: resolveMainSessionKeyFromConfig(),
      contextKey: "gateway-secrets-runtime",
      trusted: true,
    });
  };

  const recordReloadFailure = (error: unknown) => {
    const safe = sanitizeGatewaySecretsRuntimeError(error);
    params.log.warn(
      `[SECRETS_RELOADER_DEGRADED] secret reload failed; keeping last-known-good runtime snapshot (${safe.code}): ${safe.message}`,
    );
    if (degraded || closed) {
      return;
    }
    degraded = true;
    emitTransition("SECRETS_RELOADER_DEGRADED");
  };

  const recordReloadSuccess = () => {
    if (!degraded) {
      return;
    }
    degraded = false;
    params.log.info("[SECRETS_RELOADER_RECOVERED] secret runtime snapshot recovered");
    emitTransition("SECRETS_RELOADER_RECOVERED");
  };

  const logWarnings = (prepared: PreparedSecretsRuntimeSnapshot) => {
    for (const warning of prepared.warnings) {
      params.log.warn(`[${warning.code}] ${warning.message}`);
    }
  };

  const prepareSafely = async (
    config: FasedAgentConfig,
  ): Promise<PreparedSecretsRuntimeSnapshot> => {
    try {
      return await prepareSnapshot({ config });
    } catch (error) {
      throw normalizeRuntimeError(
        error,
        "SECRETS_RESOLUTION_FAILED",
        "One or more required secret references could not be resolved. Run `fased secrets audit --check` locally before retrying.",
      );
    }
  };

  const requireReloadableSnapshot = (snapshot: ConfigFileSnapshot): void => {
    if (!snapshot.exists) {
      throw missingSnapshotError();
    }
    if (!snapshot.valid) {
      throw invalidSnapshotError(snapshot);
    }
  };

  const assertSnapshotStillCurrent = async (expected: ConfigFileSnapshot): Promise<void> => {
    const current = await params.readConfigSnapshot();
    requireReloadableSnapshot(current);
    if (!sameSourceSnapshot(expected, current)) {
      throw staleSourceError();
    }
  };

  const restoreSnapshot = (previous: PreparedSecretsRuntimeSnapshot | null): void => {
    try {
      if (previous) {
        activateSnapshot(previous);
      } else {
        clearSnapshot();
      }
    } catch {
      clearSnapshot();
    }
  };

  const activateStartup = (snapshot: ConfigFileSnapshot) =>
    runTracked(async (generation) => {
      if (!snapshot.valid) {
        throw invalidSnapshotError(snapshot);
      }
      assertCurrent(generation);
      const prepared = await prepareSafely(snapshot.config);
      assertCurrent(generation);
      activateSnapshot(prepared);
      activeSourceConfig = cloneConfig(snapshot.config);
      logWarnings(prepared);
      return prepared;
    });

  const activateHotReload = (
    snapshot: ConfigFileSnapshot,
    transaction: GatewaySecretsHotReloadTransaction,
  ) =>
    runTracked(async (generation) => {
      try {
        requireReloadableSnapshot(snapshot);
        assertCurrent(generation);
        await assertSnapshotStillCurrent(snapshot);
        assertCurrent(generation);
        const prepared = await prepareSafely(snapshot.config);
        assertCurrent(generation);
        await assertSnapshotStillCurrent(snapshot);
        assertCurrent(generation);

        // Some component reload paths still read loadConfig() internally. Make
        // the candidate visible only for the bounded apply operation, and roll
        // back synchronously on every failure or stale-generation transition.
        const previous = getActiveSnapshot();
        activateSnapshot(prepared);
        try {
          await transaction.apply(prepared.config);
          assertCurrent(generation);
          await assertSnapshotStillCurrent(snapshot);
          assertCurrent(generation);
        } catch (error) {
          restoreSnapshot(previous);
          if (previous) {
            try {
              // Roll component state back only after restoring the previous
              // global snapshot so component constructors and dynamic config
              // reads cannot observe the rejected candidate.
              await transaction.rollback(previous.config);
            } catch (rollbackError) {
              throw runtimeError(
                "SECRETS_HOT_APPLY_FAILED",
                "Gateway hot reload failed. The last-known-good secret snapshot was restored, but one or more live components could not be restored and remain stopped.",
                rollbackError,
              );
            }
          }
          throw normalizeRuntimeError(
            error,
            "SECRETS_HOT_APPLY_FAILED",
            "Gateway hot reload failed; the last-known-good secret snapshot and live component state were restored.",
          );
        }

        activeSourceConfig = cloneConfig(snapshot.config);
        logWarnings(prepared);
        recordReloadSuccess();
        return prepared;
      } catch (error) {
        const safe = normalizeRuntimeError(
          error,
          "SECRETS_RELOAD_FAILED",
          "Secret reload failed without changing the active runtime snapshot.",
        );
        recordReloadFailure(safe);
        throw safe;
      }
    });

  const validateRestart = (snapshot: ConfigFileSnapshot) =>
    runTracked(async (generation) => {
      try {
        requireReloadableSnapshot(snapshot);
        assertCurrent(generation);
        await assertSnapshotStillCurrent(snapshot);
        assertCurrent(generation);
        const prepared = await prepareSafely(snapshot.config);
        assertCurrent(generation);
        await assertSnapshotStillCurrent(snapshot);
        assertCurrent(generation);
        logWarnings(prepared);
        // Intentionally do not activate. The replacement process owns the next
        // runtime snapshot; the old process remains internally consistent.
        return { warningCount: prepared.warnings.length };
      } catch (error) {
        const safe = normalizeRuntimeError(
          error,
          "SECRETS_RELOAD_FAILED",
          "Secret validation failed; the Gateway restart was not scheduled.",
        );
        recordReloadFailure(safe);
        throw safe;
      }
    });

  const reloadFromConfig = () =>
    runTracked(async (generation) => {
      try {
        assertCurrent(generation);
        const snapshot = await params.readConfigSnapshot();
        requireReloadableSnapshot(snapshot);
        if (!activeSourceConfig) {
          throw runtimeError(
            "SECRETS_RELOAD_FAILED",
            "Secret reload is unavailable before the startup snapshot is active.",
          );
        }
        assertManualSourceChangeAllowed({
          previous: activeSourceConfig,
          next: snapshot.config,
        });
        const prepared = await prepareSafely(snapshot.config);
        assertCurrent(generation);
        await assertSnapshotStillCurrent(snapshot);
        assertCurrent(generation);
        activateSnapshot(prepared);
        activeSourceConfig = cloneConfig(snapshot.config);
        logWarnings(prepared);
        recordReloadSuccess();
        return { warningCount: prepared.warnings.length };
      } catch (error) {
        const safe = normalizeRuntimeError(
          error,
          "SECRETS_RELOAD_FAILED",
          "Secret reload failed without changing the active runtime snapshot.",
        );
        recordReloadFailure(safe);
        throw safe;
      }
    });

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    closed = true;
    latestGeneration += 1;
    shutdownPromise = (async () => {
      // Every queued operation observes `closed` before it can commit. Waiting
      // for the tail also lets a provisional hot snapshot roll back first.
      await operationTail;
      activeSourceConfig = null;
      degraded = false;
      clearSnapshot();
    })();
    return shutdownPromise;
  };

  return {
    activateStartup,
    activateHotReload,
    validateRestart,
    reloadFromConfig,
    shutdown,
  };
}
