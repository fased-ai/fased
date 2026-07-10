import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileUtf8 } from "./exec-file.js";
import type { GatewayService } from "./service.js";
import { buildSystemdUnit } from "./systemd-unit.js";
import { parseSystemdEnvAssignment, parseSystemdExecStart } from "./systemd-unit.js";
import { parseSystemdShow } from "./systemd.js";

const SERVICE_NAME = "fased-gateway";
const INSTALL_HELPER = "/usr/local/sbin/fased-install-gateway-service";
const SYSTEM_UNIT_CANDIDATES = [
  `/etc/systemd/system/${SERVICE_NAME}.service`,
  `/usr/lib/systemd/system/${SERVICE_NAME}.service`,
  `/lib/systemd/system/${SERVICE_NAME}.service`,
];

export function findHostedSystemdUnitPath(
  candidates: readonly string[] = SYSTEM_UNIT_CANDIDATES,
): string | null {
  if (process.platform !== "linux") {
    return null;
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function readHostedSystemdCommand(unitPath: string) {
  try {
    const content = await fs.readFile(unitPath, "utf8");
    let workingDirectory = "";
    let execStart = "";
    const environment: Record<string, string> = {};
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("ExecStart=")) {
        execStart = line.slice("ExecStart=".length).trim();
      } else if (line.startsWith("WorkingDirectory=")) {
        workingDirectory = line.slice("WorkingDirectory=".length).trim();
      } else if (line.startsWith("Environment=")) {
        const parsed = parseSystemdEnvAssignment(line.slice("Environment=".length).trim());
        if (parsed) {
          environment[parsed.key] = parsed.value;
        }
      }
    }
    if (!execStart) {
      return null;
    }
    return {
      programArguments: parseSystemdExecStart(execStart),
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
      sourcePath: unitPath,
    };
  } catch {
    return null;
  }
}

export function resolveHostedSystemdService(): GatewayService | null {
  const unitPath = findHostedSystemdUnitPath();
  if (!unitPath) {
    return null;
  }
  const runSystemctl = async (args: string[]) => await execFileUtf8("systemctl", args);
  const runPrivilegedSystemctl = async (args: string[]) =>
    await execFileUtf8("sudo", ["-n", "systemctl", ...args]);
  const control = async (action: "stop" | "restart", stdout: NodeJS.WritableStream) => {
    const args =
      action === "restart"
        ? [action, "--no-block", `${SERVICE_NAME}.service`]
        : [action, `${SERVICE_NAME}.service`];
    const result = await runPrivilegedSystemctl(args);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `system service ${action} failed`);
    }
    stdout.write(
      `${action === "restart" ? "Restarted" : "Stopped"} system service: ${SERVICE_NAME}.service\n`,
    );
  };
  return {
    label: "systemd system service",
    loadedText: "enabled",
    notLoadedText: "disabled",
    install: async ({ programArguments, workingDirectory, environment }) => {
      await installHostedSystemdService({ programArguments, workingDirectory, environment });
    },
    uninstall: async () => {
      throw new Error("Hosted system service removal requires the VPS Hosting installer.");
    },
    stop: async ({ stdout }) => await control("stop", stdout),
    restart: async ({ stdout }) => await control("restart", stdout),
    isLoaded: async () =>
      (await runSystemctl(["is-enabled", `${SERVICE_NAME}.service`])).code === 0,
    readCommand: async () => await readHostedSystemdCommand(unitPath),
    readRuntime: async () => {
      const result = await runSystemctl([
        "show",
        `${SERVICE_NAME}.service`,
        "--no-page",
        "--property",
        "ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode",
      ]);
      if (result.code !== 0) {
        return { status: "unknown", detail: result.stderr || result.stdout || undefined };
      }
      const parsed = parseSystemdShow(result.stdout);
      const activeState = parsed.activeState?.toLowerCase();
      return {
        status: activeState === "active" ? "running" : activeState ? "stopped" : "unknown",
        state: parsed.activeState,
        subState: parsed.subState,
        pid: parsed.mainPid,
        lastExitStatus: parsed.execMainStatus,
        lastExitReason: parsed.execMainCode,
      };
    },
  };
}

function resolveRunAsUser(): string {
  const user = process.env.USER?.trim() || process.env.LOGNAME?.trim() || os.userInfo().username;
  if (!user || user === "root" || !/^[A-Za-z0-9_.@-]+$/.test(user)) {
    throw new Error("Hosted gateway repair must run as the non-root Fased app user.");
  }
  return user;
}

export function buildHostedSystemdUnit(params: {
  runAsUser: string;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
}): string {
  const baseUnit = buildSystemdUnit({
    description: "Fased Gateway (managed)",
    programArguments: params.programArguments,
    workingDirectory: params.workingDirectory,
    environment: params.environment,
  });
  const lines = baseUnit.split("\n");
  const serviceIndex = lines.findIndex((line) => line.trim() === "[Service]");
  if (serviceIndex !== -1) {
    lines.splice(
      serviceIndex + 1,
      0,
      "Type=simple",
      `User=${params.runAsUser}`,
      `Group=${params.runAsUser}`,
    );
  }
  const installIndex = lines.findIndex((line) => line.trim() === "[Install]");
  if (installIndex !== -1) {
    lines.splice(installIndex, 0, "NoNewPrivileges=true", "PrivateTmp=true");
  }
  const wantedByIndex = lines.findIndex((line) => line.trim() === "WantedBy=default.target");
  if (wantedByIndex !== -1) {
    lines[wantedByIndex] = "WantedBy=multi-user.target";
  }
  return lines.join("\n");
}

async function runHelper(unit: string, runAsUser: string): Promise<void> {
  await fs.access(INSTALL_HELPER);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("sudo", ["-n", INSTALL_HELPER, SERVICE_NAME, runAsUser], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("hosted gateway service helper timed out"));
    }, 60_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error((stderr || stdout || `service helper exited ${code}`).trim()));
      }
    });
    child.stdin.end(unit);
  });
}

export async function installHostedSystemdService(params: {
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
}): Promise<{ unitPath: string }> {
  if (process.platform !== "linux") {
    throw new Error("Hosted system service repair is supported on Linux only.");
  }
  const runAsUser = resolveRunAsUser();
  const unit = buildHostedSystemdUnit({ ...params, runAsUser });

  await spawnCommand("systemctl", ["--user", "disable", "--now", `${SERVICE_NAME}.service`]).catch(
    () => undefined,
  );
  const userUnit = path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
  await fs.rm(userUnit, { force: true }).catch(() => undefined);
  await fs.rm(`${userUnit}.d`, { recursive: true, force: true }).catch(() => undefined);
  await spawnCommand("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);

  await runHelper(unit, runAsUser);
  return { unitPath: `/etc/systemd/system/${SERVICE_NAME}.service` };
}

async function spawnCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
      }
    });
  });
}

export const __testing = { readHostedSystemdCommand, resolveRunAsUser };
