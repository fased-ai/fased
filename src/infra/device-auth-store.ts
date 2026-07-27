import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import {
  type DeviceAuthEntry,
  type DeviceAuthStore,
  normalizeDeviceAuthRole,
  normalizeDeviceAuthScopes,
} from "../shared/device-auth.js";

const DEVICE_AUTH_FILE = "device-auth.json";

function managedConfigString(vars: Record<string, unknown>, key: string): string | undefined {
  const value = vars[key];
  return typeof value === "string" ? value.trim() : undefined;
}

function resolveDeviceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "identity", DEVICE_AUTH_FILE);
}

function configDeclaresSharedDeviceAuthState(env: NodeJS.ProcessEnv): boolean {
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  try {
    const stat = fs.lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return false;
    }
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      env?: { vars?: Record<string, unknown> };
    };
    const vars = config?.env?.vars;
    if (!vars || typeof vars !== "object" || Array.isArray(vars)) {
      return false;
    }
    const profile = managedConfigString(vars, "FASED_HOST_PROFILE")?.toLowerCase();
    if (profile === "hosting") {
      return (
        managedConfigString(vars, "FASED_HOST_UPDATER_SOCKET") ===
        "/run/fased-host-updater/request.sock"
      );
    }
    const instanceId = managedConfigString(vars, "FASED_PROTECTED_LOCAL_INSTANCE") ?? "";
    return (
      profile === "local" &&
      managedConfigString(vars, "FASED_PROTECTED_LOCAL") === "1" &&
      /^[a-f0-9]{16}$/u.test(instanceId) &&
      managedConfigString(vars, "FASED_HOST_UPDATER_SOCKET") ===
        `/run/fased-local-controller/${instanceId}/request.sock`
    );
  } catch {
    return false;
  }
}

function sharedDeviceAuthState(env: NodeJS.ProcessEnv = process.env): boolean {
  const protectedLocal = String(env.FASED_PROTECTED_LOCAL ?? "").trim() === "1";
  const hosting =
    String(env.FASED_HOST_PROFILE ?? "")
      .trim()
      .toLowerCase() === "hosting";
  return protectedLocal || hosting || configDeclaresSharedDeviceAuthState(env);
}

function deviceAuthDirectoryMode(env: NodeJS.ProcessEnv = process.env): number {
  return sharedDeviceAuthState(env) ? 0o2770 : 0o700;
}

function deviceAuthFileMode(env: NodeJS.ProcessEnv = process.env): number {
  return sharedDeviceAuthState(env) ? 0o660 : 0o600;
}

function enforceDeviceAuthFileMode(filePath: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    fs.chmodSync(filePath, deviceAuthFileMode(env));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") {
      throw error;
    }
    // A peer service may own the group-shared file. Its existing mode remains authoritative.
  }
}

function enforceDeviceAuthFileGroup(
  filePath: string,
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!sharedDeviceAuthState(env)) {
    return;
  }
  try {
    const directoryStat = fs.lstatSync(directory);
    const fileStat = fs.lstatSync(filePath);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      !fileStat.isFile() ||
      fileStat.isSymbolicLink() ||
      fileStat.gid === directoryStat.gid
    ) {
      return;
    }
    fs.chownSync(filePath, fileStat.uid, directoryStat.gid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") {
      throw error;
    }
    // A peer service may own the shared file. The root controller reconciles legacy ownership.
  }
}

function enforceDeviceAuthDirectoryMode(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    fs.chmodSync(directory, deviceAuthDirectoryMode(env));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!sharedDeviceAuthState(env) || (code !== "EACCES" && code !== "EPERM")) {
      throw error;
    }
    // A peer service may own the group-shared directory. Its existing mode remains authoritative.
  }
}

function readStore(filePath: string): DeviceAuthStore | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as DeviceAuthStore;
    if (parsed?.version !== 1 || typeof parsed.deviceId !== "string") {
      return null;
    }
    if (!parsed.tokens || typeof parsed.tokens !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStore(
  filePath: string,
  store: DeviceAuthStore,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const directory = path.dirname(filePath);
  const directoryMode = deviceAuthDirectoryMode(env);
  fs.mkdirSync(directory, { recursive: true, mode: directoryMode });
  enforceDeviceAuthDirectoryMode(directory, env);
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: deviceAuthFileMode(env),
  });
  enforceDeviceAuthFileGroup(filePath, directory, env);
  enforceDeviceAuthFileMode(filePath, env);
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry | null {
  const filePath = resolveDeviceAuthPath(params.env);
  const store = readStore(filePath);
  if (!store) {
    return null;
  }
  if (store.deviceId !== params.deviceId) {
    return null;
  }
  const role = normalizeDeviceAuthRole(params.role);
  const entry = store.tokens[role];
  if (!entry || typeof entry.token !== "string") {
    return null;
  }
  return entry;
}

export function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry {
  const filePath = resolveDeviceAuthPath(params.env);
  const existing = readStore(filePath);
  const role = normalizeDeviceAuthRole(params.role);
  const next: DeviceAuthStore = {
    version: 1,
    deviceId: params.deviceId,
    tokens:
      existing && existing.deviceId === params.deviceId && existing.tokens
        ? { ...existing.tokens }
        : {},
  };
  const entry: DeviceAuthEntry = {
    token: params.token,
    role,
    scopes: normalizeDeviceAuthScopes(params.scopes),
    updatedAtMs: Date.now(),
  };
  next.tokens[role] = entry;
  writeStore(filePath, next, params.env);
  return entry;
}

export function clearDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const filePath = resolveDeviceAuthPath(params.env);
  const store = readStore(filePath);
  if (!store || store.deviceId !== params.deviceId) {
    return;
  }
  const role = normalizeDeviceAuthRole(params.role);
  if (!store.tokens[role]) {
    return;
  }
  const next: DeviceAuthStore = {
    version: 1,
    deviceId: store.deviceId,
    tokens: { ...store.tokens },
  };
  delete next.tokens[role];
  writeStore(filePath, next, params.env);
}

export function clearDeviceAuthStore(env: NodeJS.ProcessEnv = process.env): boolean {
  const filePath = resolveDeviceAuthPath(env);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}
