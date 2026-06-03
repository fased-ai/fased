import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { info, success } from "../globals.js";
import { expandHomePrefix, resolveRequiredHomeDir } from "../infra/home-dir.js";
import { getChildLogger } from "../logging.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { WebChannel } from "../utils.js";

const DEFAULT_WEB_AUTH_ACCOUNT_ID = "default";

function resolveAuthStoreUserPath(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = expandHomePrefix(trimmed, {
      home: resolveRequiredHomeDir(env, homedir),
      env,
      homedir,
    });
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

function resolveAuthStoreStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.FASED_STATE_DIR?.trim();
  if (override) {
    return resolveAuthStoreUserPath(override, env, homedir);
  }

  const home = () => resolveRequiredHomeDir(env, homedir);
  const newDir = path.join(home(), ".fased");
  return newDir;
}

function resolveAuthStoreOAuthDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.FASED_OAUTH_DIR?.trim();
  if (override) {
    return resolveAuthStoreUserPath(override, env, homedir);
  }
  return path.join(resolveAuthStoreStateDir(env, homedir), "credentials");
}

function normalizeAuthStoreE164(number: string): string {
  const digits = number
    .replace(/^whatsapp:/, "")
    .trim()
    .replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    return `+${digits.slice(1)}`;
  }
  return `+${digits}`;
}

function readAuthStoreLidReverseMapping(
  lid: string,
  opts?: { authDir?: string; lidMappingDirs?: string[] },
): string | null {
  const mappingFilename = `lid-mapping-${lid}_reverse.json`;
  const dirs = new Set<string>();
  const addDir = (dir?: string | null) => {
    if (dir) {
      dirs.add(resolveAuthStoreUserPath(dir));
    }
  };
  addDir(opts?.authDir);
  for (const dir of opts?.lidMappingDirs ?? []) {
    addDir(dir);
  }
  addDir(resolveAuthStoreOAuthDir());

  for (const dir of dirs) {
    const mappingPath = path.join(dir, mappingFilename);
    try {
      const data = fsSync.readFileSync(mappingPath, "utf8");
      const phone = JSON.parse(data) as string | number | null;
      if (phone !== null && phone !== undefined) {
        return normalizeAuthStoreE164(String(phone));
      }
    } catch {
      // Try the next location.
    }
  }
  return null;
}

function jidToE164ForAuthStore(
  jid: string,
  opts?: { authDir?: string; lidMappingDirs?: string[] },
): string | null {
  const directMatch = jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/);
  if (directMatch) {
    return `+${directMatch[1]}`;
  }

  const lidMatch = jid.match(/^(\d+)(?::\d+)?@(lid|hosted\.lid)$/);
  if (lidMatch) {
    return readAuthStoreLidReverseMapping(lidMatch[1], opts);
  }
  return null;
}

export function resolveDefaultWebAuthDir(): string {
  return path.join(resolveAuthStoreOAuthDir(), "whatsapp", DEFAULT_WEB_AUTH_ACCOUNT_ID);
}

export const WA_WEB_AUTH_DIR = resolveDefaultWebAuthDir();

export function resolveWebCredsPath(authDir: string): string {
  return path.join(authDir, "creds.json");
}

export function resolveWebCredsBackupPath(authDir: string): string {
  return path.join(authDir, "creds.json.bak");
}

export function hasWebCredsSync(authDir: string): boolean {
  try {
    const stats = fsSync.statSync(resolveWebCredsPath(authDir));
    return stats.isFile() && stats.size > 1;
  } catch {
    return false;
  }
}

export function readCredsJsonRaw(filePath: string): string | null {
  try {
    if (!fsSync.existsSync(filePath)) {
      return null;
    }
    const stats = fsSync.statSync(filePath);
    if (!stats.isFile() || stats.size <= 1) {
      return null;
    }
    return fsSync.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export function maybeRestoreCredsFromBackup(authDir: string): void {
  const logger = getChildLogger({ module: "web-session" });
  try {
    const credsPath = resolveWebCredsPath(authDir);
    const backupPath = resolveWebCredsBackupPath(authDir);
    const raw = readCredsJsonRaw(credsPath);
    if (raw) {
      // Validate that creds.json is parseable.
      JSON.parse(raw);
      return;
    }

    const backupRaw = readCredsJsonRaw(backupPath);
    if (!backupRaw) {
      return;
    }

    // Ensure backup is parseable before restoring.
    JSON.parse(backupRaw);
    fsSync.copyFileSync(backupPath, credsPath);
    try {
      fsSync.chmodSync(credsPath, 0o600);
    } catch {
      // best-effort on platforms that support it
    }
    logger.warn({ credsPath }, "restored corrupted WhatsApp creds.json from backup");
  } catch {
    // ignore
  }
}

export async function webAuthExists(authDir: string = resolveDefaultWebAuthDir()) {
  const resolvedAuthDir = resolveAuthStoreUserPath(authDir);
  maybeRestoreCredsFromBackup(resolvedAuthDir);
  const credsPath = resolveWebCredsPath(resolvedAuthDir);
  try {
    await fs.access(resolvedAuthDir);
  } catch {
    return false;
  }
  try {
    const stats = await fs.stat(credsPath);
    if (!stats.isFile() || stats.size <= 1) {
      return false;
    }
    const raw = await fs.readFile(credsPath, "utf-8");
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

async function clearLegacyBaileysAuthState(authDir: string) {
  const entries = await fs.readdir(authDir, { withFileTypes: true });
  const shouldDelete = (name: string) => {
    if (name === "oauth.json") {
      return false;
    }
    if (name === "creds.json" || name === "creds.json.bak") {
      return true;
    }
    if (!name.endsWith(".json")) {
      return false;
    }
    return /^(app-state-sync|session|sender-key|pre-key)-/.test(name);
  };
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }
      if (!shouldDelete(entry.name)) {
        return;
      }
      await fs.rm(path.join(authDir, entry.name), { force: true });
    }),
  );
}

export async function logoutWeb(params: {
  authDir?: string;
  isLegacyAuthDir?: boolean;
  runtime?: RuntimeEnv;
}) {
  const runtime = params.runtime ?? defaultRuntime;
  const resolvedAuthDir = resolveAuthStoreUserPath(params.authDir ?? resolveDefaultWebAuthDir());
  const exists = await webAuthExists(resolvedAuthDir);
  if (!exists) {
    runtime.log(info("No WhatsApp Web session found; nothing to delete."));
    return false;
  }
  if (params.isLegacyAuthDir) {
    await clearLegacyBaileysAuthState(resolvedAuthDir);
  } else {
    await fs.rm(resolvedAuthDir, { recursive: true, force: true });
  }
  runtime.log(success("Cleared WhatsApp Web credentials."));
  return true;
}

export function readWebSelfId(authDir: string = resolveDefaultWebAuthDir()) {
  // Read the cached WhatsApp Web identity (jid + E.164) from disk if present.
  try {
    const credsPath = resolveWebCredsPath(resolveAuthStoreUserPath(authDir));
    if (!fsSync.existsSync(credsPath)) {
      return { e164: null, jid: null } as const;
    }
    const raw = fsSync.readFileSync(credsPath, "utf-8");
    const parsed = JSON.parse(raw) as { me?: { id?: string } } | undefined;
    const jid = parsed?.me?.id ?? null;
    const e164 = jid ? jidToE164ForAuthStore(jid, { authDir }) : null;
    return { e164, jid } as const;
  } catch {
    return { e164: null, jid: null } as const;
  }
}

/**
 * Return the age (in milliseconds) of the cached WhatsApp web auth state, or null when missing.
 * Helpful for heartbeats/observability to spot stale credentials.
 */
export function getWebAuthAgeMs(authDir: string = resolveDefaultWebAuthDir()): number | null {
  try {
    const stats = fsSync.statSync(resolveWebCredsPath(resolveAuthStoreUserPath(authDir)));
    return Date.now() - stats.mtimeMs;
  } catch {
    return null;
  }
}

export function logWebSelfId(
  authDir: string = resolveDefaultWebAuthDir(),
  runtime: RuntimeEnv = defaultRuntime,
  includeChannelPrefix = false,
) {
  // Human-friendly log of the currently linked personal web session.
  const { e164, jid } = readWebSelfId(authDir);
  const details = e164 || jid ? `${e164 ?? "unknown"}${jid ? ` (jid ${jid})` : ""}` : "unknown";
  const prefix = includeChannelPrefix ? "Web Channel: " : "";
  runtime.log(info(`${prefix}${details}`));
}

export async function pickWebChannel(
  pref: WebChannel | "auto",
  authDir: string = resolveDefaultWebAuthDir(),
): Promise<WebChannel> {
  const choice: WebChannel = pref === "auto" ? "web" : pref;
  const hasWeb = await webAuthExists(authDir);
  if (!hasWeb) {
    throw new Error(
      `No WhatsApp Web session found. Run \`${formatCliCommand("fased channels login --channel whatsapp --verbose")}\` to link.`,
    );
  }
  return choice;
}
