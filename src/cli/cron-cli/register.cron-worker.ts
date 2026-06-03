import type { Command } from "commander";
import { danger } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { inheritOptionFromParent } from "../command-options.js";
import {
  runTaskWorkerServiceInstall,
  runTaskWorkerServiceRestart,
  runTaskWorkerServiceStart,
  runTaskWorkerServiceStatus,
  runTaskWorkerServiceStop,
  runTaskWorkerServiceUninstall,
  type TaskWorkerServiceInstallOptions,
} from "./task-worker-service.js";

type WorkerResult = {
  ok?: boolean;
  processed?: number;
  outcomes?: Array<{
    jobId?: string;
    status?: string;
    error?: string;
    delivered?: boolean;
    sessionKey?: string;
    model?: string;
    provider?: string;
  }>;
};

function parsePositiveInt(value: unknown, fallback: number): number {
  const raw = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: unknown, fallback: number): number {
  const raw = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function formatWorkerResult(result: WorkerResult, workerId: string): string {
  const processed = result.processed ?? 0;
  if (processed <= 0) {
    return `Task worker ${workerId}: no queued task runs.`;
  }
  const lines = [`Task worker ${workerId}: processed ${processed} run(s).`];
  for (const outcome of result.outcomes ?? []) {
    const status = outcome.status ?? "unknown";
    const delivery =
      outcome.delivered === true ? "delivered" : outcome.delivered === false ? "not-delivered" : "";
    const model = outcome.model
      ? outcome.provider
        ? `${outcome.provider}/${outcome.model}`
        : outcome.model
      : "";
    lines.push(
      [
        `- ${outcome.jobId ?? "unknown"}`,
        status,
        delivery,
        model,
        outcome.sessionKey ? `session ${outcome.sessionKey}` : "",
        outcome.error ? `error ${outcome.error}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveWorkerInstallOptions(
  opts: Record<string, unknown>,
  command: Command,
): TaskWorkerServiceInstallOptions {
  const parentWorkerId = inheritOptionFromParent<string>(command, "workerId");
  const parentMaxRuns = inheritOptionFromParent<string>(command, "maxRuns");
  const parentPollMs = inheritOptionFromParent<string>(command, "pollMs");
  const parentJson = inheritOptionFromParent<boolean>(command, "json");
  return {
    name: typeof opts.name === "string" ? opts.name : undefined,
    workerId: typeof opts.workerId === "string" ? opts.workerId : parentWorkerId,
    maxRuns: opts.maxRuns === "1" && parentMaxRuns ? parentMaxRuns : (opts.maxRuns as string),
    pollMs: opts.pollMs === "1000" && parentPollMs ? parentPollMs : (opts.pollMs as string),
    runtime: typeof opts.runtime === "string" ? opts.runtime : undefined,
    force: Boolean(opts.force),
    json: Boolean(opts.json || parentJson),
  };
}

function resolveWorkerLifecycleOptions(opts: Record<string, unknown>, command: Command) {
  const parentJson = inheritOptionFromParent<boolean>(command, "json");
  return {
    ...opts,
    json: Boolean(opts.json || parentJson),
  };
}

export function registerCronWorkerCommand(cron: Command) {
  const worker = cron
    .command("worker")
    .description("Run an external task worker that leases queued task runs")
    .option("--once", "Process one queue batch and exit", false)
    .option("--max-runs <n>", "Maximum queued runs to lease per batch", "1")
    .option("--poll-ms <n>", "Poll delay when no work is available", "1000")
    .option("--idle-exit-ms <n>", "Exit after this much idle time; 0 disables", "0")
    .option("--worker-id <id>", "Worker id written into queue leases")
    .option("--json", "Output JSON", false)
    .option("--quiet", "Only print batches that process work", false)
    .action(async (opts) => {
      try {
        const [{ loadConfig }, { createDefaultDeps }, { buildGatewayCronService }] =
          await Promise.all([
            import("../../config/config.js"),
            import("../deps.js"),
            import("../../gateway/server-cron.js"),
          ]);
        const workerId =
          typeof opts.workerId === "string" && opts.workerId.trim()
            ? opts.workerId.trim()
            : `task-worker:${process.pid}`;
        const maxRuns = parsePositiveInt(opts.maxRuns, 1);
        const pollMs = parsePositiveInt(opts.pollMs, 1_000);
        const idleExitMs = parseNonNegativeInt(opts.idleExitMs, 0);
        const state = buildGatewayCronService({
          cfg: loadConfig(),
          deps: createDefaultDeps(),
          broadcast: () => undefined,
        });

        const runOnce = async () =>
          await state.cron.work({
            maxRuns,
            leaseOwner: workerId,
          });

        if (opts.once) {
          const result = await runOnce();
          defaultRuntime.log(
            opts.json ? JSON.stringify(result, null, 2) : formatWorkerResult(result, workerId),
          );
          return;
        }

        let stopping = false;
        const stop = () => {
          stopping = true;
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);

        let idleSinceMs: number | null = null;
        while (!stopping) {
          const result = await runOnce();
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
          } else if (!opts.quiet || (result.processed ?? 0) > 0) {
            defaultRuntime.log(formatWorkerResult(result, workerId));
          }

          if ((result.processed ?? 0) > 0) {
            idleSinceMs = null;
          } else {
            idleSinceMs ??= Date.now();
            if (idleExitMs > 0 && Date.now() - idleSinceMs >= idleExitMs) {
              break;
            }
          }
          await sleep(pollMs);
        }
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  worker
    .command("install")
    .description("Install a managed task worker service")
    .option("--name <name>", "Named worker service for running multiple workers")
    .option("--worker-id <id>", "Worker id written into queue leases")
    .option("--max-runs <n>", "Maximum queued runs to lease per batch", "1")
    .option("--poll-ms <n>", "Poll delay when no work is available", "1000")
    .option("--runtime <runtime>", "Service runtime (node|bun). Default: node")
    .option("--force", "Reinstall/overwrite if already installed", false)
    .option("--json", "Output JSON", false)
    .action((opts, command) =>
      runTaskWorkerServiceInstall(resolveWorkerInstallOptions(opts, command)),
    );

  worker
    .command("status")
    .description("Show managed task worker service status")
    .option("--name <name>", "Named worker service")
    .option("--json", "Output JSON", false)
    .action((opts, command) =>
      runTaskWorkerServiceStatus(resolveWorkerLifecycleOptions(opts, command)),
    );

  worker
    .command("start")
    .description("Start the managed task worker service")
    .option("--name <name>", "Named worker service")
    .option("--json", "Output JSON", false)
    .action((opts, command) =>
      runTaskWorkerServiceStart(resolveWorkerLifecycleOptions(opts, command)),
    );

  worker
    .command("stop")
    .description("Stop the managed task worker service")
    .option("--name <name>", "Named worker service")
    .option("--json", "Output JSON", false)
    .action((opts, command) =>
      runTaskWorkerServiceStop(resolveWorkerLifecycleOptions(opts, command)),
    );

  worker
    .command("restart")
    .description("Restart the managed task worker service")
    .option("--name <name>", "Named worker service")
    .option("--json", "Output JSON", false)
    .action((opts, command) =>
      runTaskWorkerServiceRestart(resolveWorkerLifecycleOptions(opts, command)),
    );

  worker
    .command("uninstall")
    .description("Uninstall the managed task worker service")
    .option("--name <name>", "Named worker service")
    .option("--json", "Output JSON", false)
    .action((opts, command) =>
      runTaskWorkerServiceUninstall(resolveWorkerLifecycleOptions(opts, command)),
    );
}
