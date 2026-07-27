import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  type DeviceAuthEntry,
  type DeviceAuthStore,
  normalizeDeviceAuthRole,
  normalizeDeviceAuthScopes,
} from "../shared/device-auth.js";

const DEVICE_AUTH_FILE = "device-auth.json";

function resolveDeviceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "identity", DEVICE_AUTH_FILE);
}

function sharedDeviceAuthState(env: NodeJS.ProcessEnv = process.env): boolean {
  const protectedLocal = String(env.FASED_PROTECTED_LOCAL ?? "").trim() === "1";
  const hosting =
    String(env.FASED_HOST_PROFILE ?? "")
      .trim()
      .toLowerCase() === "hosting";
  return protectedLocal || hosting;
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
  if (!sharedDeviceAuthState(env)) {
    fs.chmodSync(directory, directoryMode);
  }
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: deviceAuthFileMode(env),
  });
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
