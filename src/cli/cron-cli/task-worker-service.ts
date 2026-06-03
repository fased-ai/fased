import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
} from "../../commands/daemon-runtime.js";
import { buildTaskWorkerInstallPlan } from "../../commands/task-worker-install-helpers.js";
import { resolveIsNixMode } from "../../config/paths.js";
import {
  resolveTaskWorkerLaunchAgentLabel,
  resolveTaskWorkerSystemdServiceName,
  resolveTaskWorkerWindowsTaskName,
} from "../../daemon/constants.js";
import { resolveTaskWorkerService } from "../../daemon/task-worker-service.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import {
  runServiceRestart,
  runServiceStart,
  runServiceStop,
  runServiceUninstall,
} from "../daemon-cli/lifecycle-core.js";
import {
  buildDaemonServiceSnapshot,
  createDaemonActionContext,
  installDaemonServiceAndEmit,
} from "../daemon-cli/response.js";
import { createCliStatusTextStyles, formatRuntimeStatus } from "../daemon-cli/shared.js";

export type TaskWorkerServiceInstallOptions = {
  name?: string;
  workerId?: string;
  maxRuns?: string | number;
  pollMs?: string | number;
  runtime?: string;
  force?: boolean;
  json?: boolean;
};

export type TaskWorkerServiceLifecycleOptions = {
  name?: string;
  json?: boolean;
};

function parsePositiveInt(value: unknown, fallback: number): number {
  const raw = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "Unknown error";
}

function renderTaskWorkerStartHints(name?: string): string[] {
  const suffix = name ? ` --name ${name}` : "";
  const base = [
    formatCliCommand(`fased task worker install${suffix}`),
    formatCliCommand(`fased task worker start${suffix}`),
  ];
  switch (process.platform) {
    case "darwin":
      return [
        ...base,
        `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/${resolveTaskWorkerLaunchAgentLabel({
          name,
          profile: process.env.FASED_PROFILE,
        })}.plist`,
      ];
    case "linux":
      return [
        ...base,
        `systemctl --user start ${resolveTaskWorkerSystemdServiceName({
          name,
          profile: process.env.FASED_PROFILE,
        })}.service`,
      ];
    case "win32":
      return [
        ...base,
        `schtasks /Run /TN "${resolveTaskWorkerWindowsTaskName({
          name,
          profile: process.env.FASED_PROFILE,
        })}"`,
      ];
    default:
      return base;
  }
}

export async function runTaskWorkerServiceInstall(opts: TaskWorkerServiceInstallOptions) {
  const json = Boolean(opts.json);
  const { stdout, warnings, emit, fail } = createDaemonActionContext({ action: "install", json });

  if (resolveIsNixMode(process.env)) {
    fail("Nix mode detected; task worker service install is disabled.");
    return;
  }

  const runtimeRaw = opts.runtime ? String(opts.runtime) : DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (!isGatewayDaemonRuntime(runtimeRaw)) {
    fail('Invalid --runtime (use "node" or "bun")');
    return;
  }

  const service = resolveTaskWorkerService(opts.name);
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    fail(`Task worker service check failed: ${describeError(err)}`);
    return;
  }
  if (loaded && !opts.force) {
    emit({
      ok: true,
      result: "already-installed",
      message: `Task worker service already ${service.loadedText}.`,
      service: buildDaemonServiceSnapshot(service, loaded),
      warnings: warnings.length ? warnings : undefined,
    });
    if (!json) {
      defaultRuntime.log(`Task worker service already ${service.loadedText}.`);
      defaultRuntime.log(
        `Reinstall with: ${formatCliCommand(
          `fased task worker install${opts.name ? ` --name ${opts.name}` : ""} --force`,
        )}`,
      );
    }
    return;
  }

  const maxRuns = parsePositiveInt(opts.maxRuns, 1);
  const pollMs = parsePositiveInt(opts.pollMs, 1_000);
  const plan = await buildTaskWorkerInstallPlan({
    env: process.env,
    name: opts.name,
    workerId: opts.workerId,
    maxRuns,
    pollMs,
    runtime: runtimeRaw,
    warn: (message) => {
      if (json) {
        warnings.push(message);
      } else {
        defaultRuntime.log(message);
      }
    },
  });

  await installDaemonServiceAndEmit({
    serviceNoun: "Task worker",
    service,
    warnings,
    emit,
    fail,
    install: async () => {
      await service.install({
        env: process.env,
        stdout,
        programArguments: plan.programArguments,
        workingDirectory: plan.workingDirectory,
        environment: plan.environment,
        description: plan.description,
      });
    },
  });

  if (!json) {
    defaultRuntime.log(`Task worker id: ${plan.workerId}`);
  }
}

export async function runTaskWorkerServiceStatus(opts: TaskWorkerServiceLifecycleOptions) {
  const json = Boolean(opts.json);
  const service = resolveTaskWorkerService(opts.name);
  const loaded = await service.isLoaded({ env: process.env }).catch(() => false);
  const runtime = await service.readRuntime(process.env).catch((err) => ({
    status: "unknown" as const,
    detail: describeError(err),
  }));
  const command = await service.readCommand(process.env).catch(() => null);
  const payload = {
    ok: true,
    service: buildDaemonServiceSnapshot(service, loaded),
    runtime,
    command,
  };
  if (json) {
    defaultRuntime.log(JSON.stringify(payload, null, 2));
    return;
  }

  const styles = createCliStatusTextStyles();
  defaultRuntime.log(
    `${styles.label("Service:")} ${service.label} (${
      loaded ? service.loadedText : service.notLoadedText
    })`,
  );
  defaultRuntime.log(`${styles.label("Runtime:")} ${formatRuntimeStatus(runtime) ?? "unknown"}`);
  if ("pid" in runtime && typeof runtime.pid === "number") {
    defaultRuntime.log(`${styles.label("PID:")} ${runtime.pid}`);
  }
  if (runtime.detail) {
    defaultRuntime.log(`${styles.label("Detail:")} ${runtime.detail}`);
  }
  if (command?.programArguments?.length) {
    defaultRuntime.log(`${styles.label("Command:")} ${command.programArguments.join(" ")}`);
  }
  if (command?.sourcePath) {
    defaultRuntime.log(`${styles.label("Service file:")} ${command.sourcePath}`);
  }
}

export async function runTaskWorkerServiceUninstall(opts: TaskWorkerServiceLifecycleOptions) {
  await runServiceUninstall({
    serviceNoun: "Task worker",
    service: resolveTaskWorkerService(opts.name),
    opts,
    stopBeforeUninstall: true,
    assertNotLoadedAfterUninstall: true,
  });
}

export async function runTaskWorkerServiceStart(opts: TaskWorkerServiceLifecycleOptions) {
  await runServiceStart({
    serviceNoun: "Task worker",
    service: resolveTaskWorkerService(opts.name),
    renderStartHints: () => renderTaskWorkerStartHints(opts.name),
    opts,
  });
}

export async function runTaskWorkerServiceStop(opts: TaskWorkerServiceLifecycleOptions) {
  await runServiceStop({
    serviceNoun: "Task worker",
    service: resolveTaskWorkerService(opts.name),
    opts,
  });
}

export async function runTaskWorkerServiceRestart(opts: TaskWorkerServiceLifecycleOptions) {
  await runServiceRestart({
    serviceNoun: "Task worker",
    service: resolveTaskWorkerService(opts.name),
    renderStartHints: () => renderTaskWorkerStartHints(opts.name),
    opts,
  });
}
