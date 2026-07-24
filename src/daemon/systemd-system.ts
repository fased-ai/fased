import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { VERSION } from "../version.js";
import { execFileUtf8 } from "./exec-file.js";
import type { GatewayService } from "./service.js";
import { buildSystemdUnit } from "./systemd-unit.js";
import { parseSystemdEnvAssignment, parseSystemdExecStart } from "./systemd-unit.js";
import { parseSystemdShow } from "./systemd.js";

const SERVICE_NAME = "fased-gateway";
const SYSTEM_UNIT_CANDIDATES = [
  `/etc/systemd/system/${SERVICE_NAME}.service`,
  `/usr/lib/systemd/system/${SERVICE_NAME}.service`,
  `/lib/systemd/system/${SERVICE_NAME}.service`,
];
const PROTECTED_LOCAL_GATEWAY_UNIT_PATTERN = /^fased-gateway-([a-f0-9]{16})\.service$/u;

export type RootManagedSystemdTarget = {
  profile: "hosting" | "protected-local";
  serviceName: string;
  unitPath: string;
  updaterSocketPath: string;
};

function resolveDefaultManagedManifestPath(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.FASED_MANAGED_INSTALL_MANIFEST?.trim();
  if (explicit) {
    return path.isAbsolute(explicit) ? path.resolve(explicit) : null;
  }
  const stateDir = env.FASED_STATE_DIR?.trim();
  if (stateDir) {
    return path.isAbsolute(stateDir) ? path.join(path.resolve(stateDir), "install.json") : null;
  }
  const home = env.HOME?.trim() || os.homedir();
  return home && path.isAbsolute(home)
    ? path.join(path.resolve(home), ".fased", "install.json")
    : null;
}

export function parseProtectedLocalSystemdTarget(
  manifest: unknown,
  unitRoot = "/etc/systemd/system",
): RootManagedSystemdTarget | null {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return null;
  }
  const candidate = manifest as {
    schemaVersion?: unknown;
    profile?: unknown;
    service?: { name?: unknown; scope?: unknown };
  };
  if (
    (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2) ||
    candidate.profile !== "protected-local" ||
    candidate.service?.scope !== "system" ||
    typeof candidate.service.name !== "string"
  ) {
    return null;
  }
  const serviceName = candidate.service.name.trim();
  const match = PROTECTED_LOCAL_GATEWAY_UNIT_PATTERN.exec(serviceName);
  if (!match) {
    return null;
  }
  const instanceId = match[1];
  return {
    profile: "protected-local",
    serviceName,
    unitPath: path.join(unitRoot, serviceName),
    updaterSocketPath: `/run/fased-local-controller/${instanceId}/request.sock`,
  };
}

export function resolveRootManagedSystemdTarget(
  options: {
    env?: NodeJS.ProcessEnv;
    manifestPath?: string | null;
    unitRoot?: string;
    hostedCandidates?: readonly string[];
  } = {},
): RootManagedSystemdTarget | null {
  if (process.platform !== "linux") {
    return null;
  }
  const env = options.env ?? process.env;
  const manifestPath =
    options.manifestPath === undefined
      ? resolveDefaultManagedManifestPath(env)
      : options.manifestPath;
  if (manifestPath) {
    try {
      const raw = readFileSync(manifestPath, "utf8");
      if (Buffer.byteLength(raw) <= 1024 * 1024) {
        const protectedLocal = parseProtectedLocalSystemdTarget(JSON.parse(raw), options.unitRoot);
        if (protectedLocal) {
          return protectedLocal;
        }
      }
    } catch {
      // Legacy and incomplete installs fall through to the fixed Hosting unit check.
    }
  }
  const unitPath = findHostedSystemdUnitPath(options.hostedCandidates);
  return unitPath
    ? {
        profile: "hosting",
        serviceName: `${SERVICE_NAME}.service`,
        unitPath,
        updaterSocketPath:
          env.FASED_HOST_UPDATER_SOCKET?.trim() || "/run/fased-host-updater/request.sock",
      }
    : null;
}

export function findHostedSystemdUnitPath(
  candidates: readonly string[] = SYSTEM_UNIT_CANDIDATES,
): string | null {
  if (process.platform !== "linux") {
    return null;
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function buildRootManagedSystemctlControlArgs(
  action: "stop" | "restart",
  serviceName = `${SERVICE_NAME}.service`,
): string[] {
  return [action, serviceName];
}

async function restartRootManagedServiceWithoutPrivilege(socketPath: string) {
  const transactionId = randomUUID();
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(30_000);
    let body = "";
    let settled = false;
    const finish = (code: number, stderr = "") => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve({ code, stdout: "", stderr });
    };
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          schemaVersion: 2,
          op: "restartGateway",
          transactionId,
          version: VERSION,
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline < 0) {
        return;
      }
      try {
        const response = JSON.parse(body.slice(0, newline));
        if (
          response?.ok === true &&
          response.transactionId === transactionId &&
          response.version === VERSION &&
          response.phase === "restarted"
        ) {
          finish(0);
          return;
        }
        finish(1, response?.error || "Root controller rejected the Gateway restart");
      } catch (error) {
        finish(1, `Root controller returned an invalid response: ${String(error)}`);
      }
    });
    socket.once("timeout", () => finish(1, "Root controller timed out during Gateway restart"));
    socket.once("error", (error) =>
      finish(1, `Root controller is unavailable for Gateway restart: ${error.message}`),
    );
    socket.once("close", () => finish(1, "Root controller closed before restart confirmation"));
  });
}

async function readRootManagedSystemdCommand(unitPath: string) {
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
  const target = resolveRootManagedSystemdTarget();
  if (!target) {
    return null;
  }
  const runSystemctl = async (args: string[]) => await execFileUtf8("systemctl", args);
  const control = async (action: "stop" | "restart", stdout: NodeJS.WritableStream) => {
    if (action === "stop") {
      throw new Error(
        "Stopping the root-managed Gateway requires host administration; the operator has no persistent root service authority.",
      );
    }
    const result = await restartRootManagedServiceWithoutPrivilege(target.updaterSocketPath);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `system service ${action} failed`);
    }
    stdout.write(
      `${action === "restart" ? "Restarted" : "Stopped"} system service: ${target.serviceName}\n`,
    );
  };
  return {
    label: "systemd system service",
    loadedText: "enabled",
    notLoadedText: "disabled",
    install: async ({ programArguments, workingDirectory, environment }) => {
      if (target.profile === "protected-local") {
        throw new Error(
          "Protected Local system services are installed transactionally by the verified Local bootstrap.",
        );
      }
      await installHostedSystemdService({ programArguments, workingDirectory, environment });
    },
    uninstall: async () => {
      throw new Error(
        `${target.profile === "hosting" ? "Hosting" : "Protected Local"} system service removal requires its verified installer.`,
      );
    },
    stop: async ({ stdout }) => await control("stop", stdout),
    restart: async ({ stdout }) => await control("restart", stdout),
    isLoaded: async () => (await runSystemctl(["is-enabled", target.serviceName])).code === 0,
    readCommand: async () => await readRootManagedSystemdCommand(target.unitPath),
    readRuntime: async () => {
      const result = await runSystemctl([
        "show",
        target.serviceName,
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
    environment: {
      ...params.environment,
      FASED_HOST_PROFILE: "hosting",
      FASED_WALLET_LOCAL_SIGNER_LIFECYCLE: "external",
      FASED_WALLET_LOCAL_SIGNER_SOCKET: "/run/fased-signerd/app.sock",
    },
  });
  const lines = baseUnit.split("\n");
  const unitIndex = lines.findIndex((line) => line.trim() === "[Unit]");
  if (unitIndex !== -1) {
    lines.splice(unitIndex + 1, 0, "After=fased-signerd.service", "Wants=fased-signerd.service");
  }
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
    lines.splice(
      installIndex,
      0,
      "UMask=0077",
      "NoNewPrivileges=true",
      "PrivateTmp=true",
      "PrivateDevices=true",
      "ProtectSystem=strict",
      "ProtectHome=read-only",
      `ReadWritePaths=/home/${params.runAsUser}/.fased`,
      "ProtectKernelTunables=true",
      "ProtectKernelModules=true",
      "ProtectKernelLogs=true",
      "ProtectControlGroups=true",
      "ProtectClock=true",
      "ProtectHostname=true",
      "LockPersonality=true",
      "RestrictSUIDSGID=true",
      "RestrictRealtime=true",
      "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
      "SystemCallArchitectures=native",
      "CapabilityBoundingSet=",
      "AmbientCapabilities=",
    );
  }
  const wantedByIndex = lines.findIndex((line) => line.trim() === "WantedBy=default.target");
  if (wantedByIndex !== -1) {
    lines[wantedByIndex] = "WantedBy=multi-user.target";
  }
  return lines.join("\n");
}

async function runHelper(unit: string): Promise<void> {
  void unit;
  throw new Error(
    "The app account cannot install or mutate the root-managed hosted service. Use the exact tagged, attested Hosting repair from the provider root console; never run the app checkout with sudo.",
  );
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

  await runHelper(unit);
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

export const __testing = {
  buildRootManagedSystemctlControlArgs,
  readRootManagedSystemdCommand,
  restartRootManagedServiceWithoutPrivilege,
  resolveRunAsUser,
};
