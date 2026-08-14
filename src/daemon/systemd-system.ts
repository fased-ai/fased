import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileUtf8 } from "./exec-file.js";
import type { GatewayService } from "./service.js";
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
  return {
    profile: "protected-local",
    serviceName,
    unitPath: path.join(unitRoot, serviceName),
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
  const control = async (action: "stop" | "restart") => {
    throw new Error(
      `${action === "restart" ? "Restarting" : "Stopping"} the root-managed Gateway is owned by the Go lifecycle transaction; Node has no root service authority.`,
    );
  };
  return {
    label: "systemd system service",
    loadedText: "enabled",
    notLoadedText: "disabled",
    install: async () => {
      throw new Error(
        "Root-managed system services are installed only by the verified Go lifecycle installer.",
      );
    },
    uninstall: async () => {
      throw new Error(
        `${target.profile === "hosting" ? "Hosting" : "Protected Local"} system service removal requires its verified installer.`,
      );
    },
    stop: async () => await control("stop"),
    restart: async () => await control("restart"),
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

export const __testing = {
  readRootManagedSystemdCommand,
};
