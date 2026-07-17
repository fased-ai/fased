import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/runs.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import type { CliDeps } from "../cli/deps.js";
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { isRestartEnabled } from "../config/commands.js";
import type { loadConfig } from "../config/config.js";
import { startGmailWatcherWithLogs } from "../hooks/gmail-watcher-lifecycle.js";
import { stopGmailWatcher } from "../hooks/gmail-watcher.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import {
  deferGatewayRestartUntilIdle,
  emitGatewayRestart,
  setGatewaySigusr1RestartPolicy,
} from "../infra/restart.js";
import { setCommandLaneConcurrency, getTotalQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import type { ChannelKind, GatewayReloadPlan } from "./config-reload.js";
import { resolveHooksConfig } from "./hooks.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import { buildGatewayCronService, type GatewayCronState } from "./server-cron.js";
import { markGatewayModelCatalogStaleForReload } from "./server-model-catalog.js";

type GatewayHotReloadState = {
  hooksConfig: ReturnType<typeof resolveHooksConfig>;
  heartbeatRunner: HeartbeatRunner;
  cronState: GatewayCronState;
  browserControl: Awaited<ReturnType<typeof startBrowserControlServerIfEnabled>> | null;
};

function shouldInvalidateGatewayModelCatalog(changedPaths: string[]): boolean {
  return changedPaths.some(
    (path) =>
      path === "models" ||
      path.startsWith("models.") ||
      path === "agents.defaults.model" ||
      path.startsWith("agents.defaults.model.") ||
      path === "agents.defaults.models" ||
      path.startsWith("agents.defaults.models."),
  );
}

export function createGatewayReloadHandlers(params: {
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  getState: () => GatewayHotReloadState;
  setState: (state: GatewayHotReloadState) => void;
  startChannel: (name: ChannelKind) => Promise<void>;
  stopChannel: (name: ChannelKind) => Promise<void>;
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logBrowser: { error: (msg: string) => void };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  logCron: { error: (msg: string) => void };
  logReload: { info: (msg: string) => void; warn: (msg: string) => void };
}) {
  const createHotReloadTransaction = (plan: GatewayReloadPlan) => {
    const originalState = params.getState();
    let workingState = { ...originalState };
    let policyMutated = false;
    let heartbeatMutated = false;
    let cronMutated = false;
    let browserMutated = false;
    let gmailMutated = false;
    let concurrencyMutated = false;
    const channelsMutated: ChannelKind[] = [];
    let applyStarted = false;
    let rollbackStarted = false;

    const publishState = () => {
      params.setState({ ...workingState });
    };

    const startGmailWatcherForReload = async (
      config: ReturnType<typeof loadConfig>,
      phase: "apply" | "rollback",
    ) => {
      let failed = false;
      await startGmailWatcherWithLogs({
        cfg: config,
        log: {
          info: (message) => params.logHooks.info(message),
          warn: () => params.logHooks.warn(`gmail watcher ${phase} did not start`),
          error: () => {
            failed = true;
            params.logHooks.error(`gmail watcher ${phase} failed to start`);
          },
        },
        onSkipped: () =>
          params.logHooks.info(`skipping gmail watcher ${phase} (FASED_SKIP_GMAIL_WATCHER=1)`),
      });
      if (failed) {
        throw new Error(`gmail watcher ${phase} failed`);
      }
    };

    const apply = async (nextConfig: ReturnType<typeof loadConfig>) => {
      if (applyStarted) {
        throw new Error("hot reload transaction already started");
      }
      applyStarted = true;

      policyMutated = true;
      setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });

      if (plan.reloadHooks) {
        workingState.hooksConfig = resolveHooksConfig(nextConfig);
      }

      if (plan.restartHeartbeat) {
        heartbeatMutated = true;
        workingState.heartbeatRunner.updateConfig(nextConfig);
      }

      resetDirectoryCache();
      if (shouldInvalidateGatewayModelCatalog(plan.changedPaths)) {
        markGatewayModelCatalogStaleForReload();
      }

      if (plan.restartCron) {
        cronMutated = true;
        workingState.cronState.cron.stop();
        workingState.cronState = buildGatewayCronService({
          cfg: nextConfig,
          deps: params.deps,
          broadcast: params.broadcast,
        });
        // Publish the candidate handle before awaiting startup so a failed or
        // cancelled transaction can always stop the exact instance it made.
        publishState();
        await workingState.cronState.cron.start();
      }

      if (plan.restartBrowserControl) {
        browserMutated = true;
        try {
          await workingState.browserControl?.stop();
        } finally {
          workingState.browserControl = null;
          publishState();
        }
        workingState.browserControl = await startBrowserControlServerIfEnabled();
        publishState();
      }

      if (plan.restartGmailWatcher) {
        gmailMutated = true;
        await stopGmailWatcher();
        await startGmailWatcherForReload(nextConfig, "apply");
      }

      if (plan.restartChannels.size > 0) {
        if (
          isTruthyEnvValue(process.env.FASED_SKIP_CHANNELS) ||
          isTruthyEnvValue(process.env.FASED_SKIP_PROVIDERS)
        ) {
          params.logChannels.info(
            "skipping channel reload (FASED_SKIP_CHANNELS=1 or FASED_SKIP_PROVIDERS=1)",
          );
        } else {
          for (const channel of plan.restartChannels) {
            channelsMutated.push(channel);
            params.logChannels.info(`restarting ${channel} channel`);
            await params.stopChannel(channel);
            await params.startChannel(channel);
          }
        }
      }

      concurrencyMutated = true;
      setCommandLaneConcurrency(CommandLane.Cron, nextConfig.cron?.maxConcurrentRuns ?? 1);
      setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(nextConfig));
      setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(nextConfig));

      if (plan.hotReasons.length > 0) {
        params.logReload.info(`config hot reload applied (${plan.hotReasons.join(", ")})`);
      } else if (plan.noopPaths.length > 0) {
        params.logReload.info(
          `config change applied (dynamic reads: ${plan.noopPaths.join(", ")})`,
        );
      }

      publishState();
    };

    const rollback = async (previousConfig: ReturnType<typeof loadConfig>) => {
      if (!applyStarted || rollbackStarted) {
        return;
      }
      rollbackStarted = true;
      const failures: unknown[] = [];
      const capture = async (operation: () => void | Promise<void>): Promise<boolean> => {
        try {
          await operation();
          return true;
        } catch (error) {
          failures.push(error);
          return false;
        }
      };

      if (concurrencyMutated) {
        await capture(() => {
          setCommandLaneConcurrency(CommandLane.Cron, previousConfig.cron?.maxConcurrentRuns ?? 1);
          setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(previousConfig));
          setCommandLaneConcurrency(
            CommandLane.Subagent,
            resolveSubagentMaxConcurrent(previousConfig),
          );
        });
      }

      for (const channel of channelsMutated.toReversed()) {
        const stopped = await capture(async () => await params.stopChannel(channel));
        if (stopped) {
          // A failed previous-config start leaves the channel stopped instead
          // of letting it continue with candidate credentials.
          await capture(async () => await params.startChannel(channel));
        }
      }

      if (gmailMutated) {
        const stopped = await capture(async () => await stopGmailWatcher());
        if (stopped) {
          await capture(async () => await startGmailWatcherForReload(previousConfig, "rollback"));
        }
      }

      if (browserMutated) {
        const candidateBrowser = workingState.browserControl;
        const candidateStopped = await capture(async () => await candidateBrowser?.stop());
        workingState.browserControl = null;
        publishState();
        if (candidateStopped) {
          let restoredBrowser: GatewayHotReloadState["browserControl"] = null;
          const restored = await capture(async () => {
            restoredBrowser = await startBrowserControlServerIfEnabled();
          });
          if (restored) {
            workingState.browserControl = restoredBrowser;
            publishState();
          }
        }
      }

      if (cronMutated) {
        await capture(() => workingState.cronState.cron.stop());
        workingState.cronState = originalState.cronState;
        publishState();
        await capture(async () => await originalState.cronState.cron.start());
      }

      if (heartbeatMutated) {
        const restored = await capture(() =>
          workingState.heartbeatRunner.updateConfig(previousConfig),
        );
        if (!restored) {
          await capture(() => workingState.heartbeatRunner.stop());
        }
      }

      workingState.hooksConfig = originalState.hooksConfig;
      if (policyMutated) {
        await capture(() =>
          setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(previousConfig) }),
        );
      }
      resetDirectoryCache();
      if (shouldInvalidateGatewayModelCatalog(plan.changedPaths)) {
        markGatewayModelCatalogStaleForReload();
      }
      publishState();

      if (failures.length > 0) {
        // Do not include component errors here: callers deliberately expose a
        // stable sanitized code and leave failed-to-restore components stopped.
        throw new Error(`hot reload rollback incomplete (${failures.length} component failure(s))`);
      }
    };

    return { apply, rollback };
  };

  const applyHotReload = async (
    plan: GatewayReloadPlan,
    nextConfig: ReturnType<typeof loadConfig>,
  ) => {
    await createHotReloadTransaction(plan).apply(nextConfig);
  };

  let restartPending = false;
  let restartDeferral: ReturnType<typeof deferGatewayRestartUntilIdle> | null = null;

  const cancelPendingGatewayRestart = (): boolean => {
    const cancelled = restartDeferral?.cancel() ?? false;
    restartDeferral = null;
    restartPending = false;
    if (cancelled) {
      params.logReload.info(
        "cancelled deferred config restart before evaluating the latest revision",
      );
    }
    return cancelled;
  };

  const requestGatewayRestart = (
    plan: GatewayReloadPlan,
    nextConfig: ReturnType<typeof loadConfig>,
  ) => {
    setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
    const reasons = plan.restartReasons.length
      ? plan.restartReasons.join(", ")
      : plan.changedPaths.join(", ");

    if (process.listenerCount("SIGUSR1") === 0) {
      params.logReload.warn("no SIGUSR1 listener found; restart skipped");
      return;
    }

    const getActiveCounts = () => {
      const queueSize = getTotalQueueSize();
      const pendingReplies = getTotalPendingReplies();
      const embeddedRuns = getActiveEmbeddedRunCount();
      return {
        queueSize,
        pendingReplies,
        embeddedRuns,
        totalActive: queueSize + pendingReplies + embeddedRuns,
      };
    };
    const formatActiveDetails = (counts: ReturnType<typeof getActiveCounts>) => {
      const details = [];
      if (counts.queueSize > 0) {
        details.push(`${counts.queueSize} operation(s)`);
      }
      if (counts.pendingReplies > 0) {
        details.push(`${counts.pendingReplies} reply(ies)`);
      }
      if (counts.embeddedRuns > 0) {
        details.push(`${counts.embeddedRuns} embedded run(s)`);
      }
      return details;
    };
    const active = getActiveCounts();

    if (active.totalActive > 0) {
      // A newer validated revision replaces an older config deferral. Restart
      // startup always reads the latest source, so retaining an older poll
      // would only let a superseded decision fire.
      if (restartPending) {
        cancelPendingGatewayRestart();
      }
      restartPending = true;
      const initialDetails = formatActiveDetails(active);
      params.logReload.warn(
        `config change requires gateway restart (${reasons}) — deferring until ${initialDetails.join(", ")} complete`,
      );

      const deferral = deferGatewayRestartUntilIdle({
        getPendingCount: () => getActiveCounts().totalActive,
        hooks: {
          onReady: () => {
            restartPending = false;
            restartDeferral = null;
            params.logReload.info("all operations and replies completed; restarting gateway now");
          },
          onTimeout: (_pending, elapsedMs) => {
            const remaining = formatActiveDetails(getActiveCounts());
            restartPending = false;
            restartDeferral = null;
            params.logReload.warn(
              `restart timeout after ${elapsedMs}ms with ${remaining.join(", ")} still active; restarting anyway`,
            );
          },
          onCheckError: (err) => {
            restartPending = false;
            restartDeferral = null;
            params.logReload.warn(
              `restart deferral check failed (${String(err)}); restarting gateway now`,
            );
          },
        },
      });
      restartDeferral = deferral.isPending() ? deferral : null;
    } else {
      // No active operations or pending replies, restart immediately
      params.logReload.warn(`config change requires gateway restart (${reasons})`);
      const emitted = emitGatewayRestart();
      if (!emitted) {
        params.logReload.info("gateway restart already scheduled; skipping duplicate signal");
      }
    }
  };

  return {
    applyHotReload,
    cancelPendingGatewayRestart,
    createHotReloadTransaction,
    requestGatewayRestart,
  };
}
