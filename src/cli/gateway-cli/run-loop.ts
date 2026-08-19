import type { startGatewayServer } from "../../gateway/server.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { restartGatewayProcessWithFreshPid } from "../../infra/process-respawn.js";
import {
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
  markGatewaySigusr1RestartHandled,
} from "../../infra/restart.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  markGatewayDraining,
  resetAllLanes,
  waitForAllTasks,
} from "../../process/command-queue.js";
import { createRestartIterationHook } from "../../process/restart-recovery.js";
import type { defaultRuntime } from "../../runtime.js";

const gatewayLog = createSubsystemLogger("gateway");

type GatewayRunSignalAction = "stop" | "restart";

export async function runGatewayLoop(params: {
  start: () => Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  runtime: typeof defaultRuntime;
  lockPort?: number;
}) {
  let lock = await acquireGatewayLock({ port: params.lockPort });
  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  let shuttingDown = false;
  let restartResolver: (() => void) | null = null;

  const cleanupSignals = () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGUSR1", onSigusr1);
  };
  const exitProcess = (code: number) => {
    cleanupSignals();
    params.runtime.exit(code);
  };
  const releaseLockIfHeld = async (): Promise<boolean> => {
    if (!lock) {
      return false;
    }
    await lock.release();
    lock = null;
    return true;
  };
  const reacquireLockForInProcessRestart = async (): Promise<boolean> => {
    try {
      lock = await acquireGatewayLock({ port: params.lockPort });
      return true;
    } catch (err) {
      gatewayLog.error(`failed to reacquire gateway lock for in-process restart: ${String(err)}`);
      exitProcess(1);
      return false;
    }
  };
  const handleRestartAfterServerClose = async () => {
    const hadLock = await releaseLockIfHeld();
    // Release the lock BEFORE spawning so the child can acquire it immediately.
    const respawn = restartGatewayProcessWithFreshPid();
    if (respawn.mode === "spawned" || respawn.mode === "supervised") {
      const modeLabel =
        respawn.mode === "spawned"
          ? `spawned pid ${respawn.pid ?? "unknown"}`
          : "supervisor restart";
      gatewayLog.info(`restart mode: full process restart (${modeLabel})`);
      exitProcess(0);
      return;
    }
    if (respawn.mode === "failed") {
      gatewayLog.warn(
        `full process restart failed (${respawn.detail ?? "unknown error"}); falling back to in-process restart`,
      );
    } else {
      gatewayLog.info("restart mode: in-process restart (FASED_NO_RESPAWN)");
    }
    if (hadLock && !(await reacquireLockForInProcessRestart())) {
      return;
    }
    shuttingDown = false;
    restartResolver?.();
  };
  const handleStopAfterServerClose = async () => {
    await releaseLockIfHeld();
    exitProcess(0);
  };
  const exitAfterFailedShutdown = async () => {
    try {
      await releaseLockIfHeld();
    } catch (err) {
      gatewayLog.error(`failed to release gateway lock after shutdown failure: ${String(err)}`);
    }
    exitProcess(1);
  };

  const DRAIN_TIMEOUT_MS = 30_000;
  const SHUTDOWN_TIMEOUT_MS = 5_000;

  const request = (action: GatewayRunSignalAction, signal: string) => {
    if (shuttingDown) {
      gatewayLog.info(`received ${signal} during shutdown; ignoring`);
      return;
    }
    shuttingDown = true;
    const isRestart = action === "restart";
    gatewayLog.info(`received ${signal}; ${isRestart ? "restarting" : "shutting down"}`);

    // The stop deadline includes accepted queued work plus service teardown.
    const forceExitMs = DRAIN_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS;
    let forceExitTriggered = false;
    const forceExitTimer = setTimeout(() => {
      forceExitTriggered = true;
      gatewayLog.error("shutdown timed out; exiting without full cleanup");
      void exitAfterFailedShutdown();
    }, forceExitMs);

    void (async () => {
      let closeFailure: unknown;
      try {
        // Reject new enqueues immediately during the drain window so sessions
        // get an explicit lifecycle error instead of silently losing tasks.
        // A normal stop is stricter: it must not checkpoint a still-writing
        // ledger after the deadline.
        markGatewayDraining();
        gatewayLog.info(
          `draining accepted tasks before ${isRestart ? "restart" : "stop"} (timeout ${DRAIN_TIMEOUT_MS}ms)`,
        );
        const { drained } = await waitForAllTasks(DRAIN_TIMEOUT_MS);
        if (drained) {
          gatewayLog.info("all accepted tasks drained");
        } else if (isRestart) {
          gatewayLog.warn("drain timeout reached; proceeding with restart");
        } else {
          throw new Error("drain timeout reached; refusing task-ledger checkpoint during stop");
        }

        await server?.close({
          reason: isRestart ? "gateway restarting" : "gateway stopping",
          restartExpectedMs: isRestart ? 1500 : null,
        });
      } catch (err) {
        gatewayLog.error(`shutdown error: ${String(err)}`);
        closeFailure = err;
      } finally {
        clearTimeout(forceExitTimer);
        server = null;
      }
      if (forceExitTriggered) {
        return;
      }
      if (closeFailure !== undefined) {
        // Lifecycle close includes durable state capture. A checkpoint
        // failure cannot be treated as a normal stop or restart: release
        // the lock, suppress respawn, and let systemd observe failure.
        await exitAfterFailedShutdown();
        return;
      }
      if (isRestart) {
        await handleRestartAfterServerClose();
      } else {
        await handleStopAfterServerClose();
      }
    })();
  };

  const onSigterm = () => {
    gatewayLog.info("signal SIGTERM received");
    request("stop", "SIGTERM");
  };
  const onSigint = () => {
    gatewayLog.info("signal SIGINT received");
    request("stop", "SIGINT");
  };
  const onSigusr1 = () => {
    gatewayLog.info("signal SIGUSR1 received");
    const authorized = consumeGatewaySigusr1RestartAuthorization();
    if (!authorized && !isGatewaySigusr1RestartExternallyAllowed()) {
      gatewayLog.warn(
        "SIGUSR1 restart ignored (not authorized; commands.restart=false or use gateway tool).",
      );
      return;
    }
    markGatewaySigusr1RestartHandled();
    request("restart", "SIGUSR1");
  };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("SIGUSR1", onSigusr1);

  try {
    const onIteration = createRestartIterationHook(() => {
      // After an in-process restart (SIGUSR1), reset command-queue lane state.
      // Interrupted tasks from the previous lifecycle may have left `active`
      // counts elevated (their finally blocks never ran), permanently blocking
      // new work from draining. This must happen here — at the restart
      // coordinator level — rather than inside individual subsystem init
      // functions, to avoid surprising cross-cutting side effects.
      resetAllLanes();
    });

    // Keep process alive; SIGUSR1 triggers an in-process restart (no supervisor required).
    // SIGTERM/SIGINT still exit after a graceful shutdown.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      onIteration();
      server = await params.start();
      await new Promise<void>((resolve) => {
        restartResolver = resolve;
      });
    }
  } finally {
    await releaseLockIfHeld();
    cleanupSignals();
  }
}
