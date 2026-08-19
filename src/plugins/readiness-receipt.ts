import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PluginRegistry } from "./registry.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CAPABILITY = /^[a-z][a-z0-9.-]{0,63}$/;

export type PluginLockEntry = {
  id: string;
  origin: "bundled" | "store";
  digest: string;
  apiCapability: string;
  required: boolean;
};

export type PluginLock = {
  schemaVersion: 1;
  type: "fased-plugin-lock";
  entries: PluginLockEntry[];
};

export function canonicalPluginLock(value: unknown): PluginLock {
  const lock = value as Partial<PluginLock>;
  if (
    lock.schemaVersion !== 1 ||
    lock.type !== "fased-plugin-lock" ||
    !Array.isArray(lock.entries)
  ) {
    throw new Error("plugin lock schema or type is unsupported");
  }
  let previous = "";
  const entries = lock.entries.map((raw) => {
    const entry = raw as Partial<PluginLockEntry>;
    if (
      typeof entry.id !== "string" ||
      !ID.test(entry.id) ||
      entry.id <= previous ||
      (entry.origin !== "bundled" && entry.origin !== "store") ||
      typeof entry.digest !== "string" ||
      !DIGEST.test(entry.digest) ||
      typeof entry.apiCapability !== "string" ||
      !CAPABILITY.test(entry.apiCapability) ||
      typeof entry.required !== "boolean"
    ) {
      throw new Error("plugin lock entries are not canonical and digest-bound");
    }
    previous = entry.id;
    return {
      id: entry.id,
      origin: entry.origin,
      digest: entry.digest,
      apiCapability: entry.apiCapability,
      required: entry.required,
    };
  });
  return { schemaVersion: 1, type: "fased-plugin-lock", entries };
}

export function readCanonicalPluginLock(lockPath: string): PluginLock {
  return canonicalPluginLock(JSON.parse(fs.readFileSync(lockPath, "utf8")));
}

export function writePluginReadinessReceipt(params: {
  registry: PluginRegistry;
  lockPath?: string;
  outputPath?: string;
  generationId?: string;
}): void {
  const lockPath = params.lockPath ?? process.env.FASED_PLUGIN_LOCK_PATH?.trim();
  const outputPath = params.outputPath ?? process.env.FASED_PLUGIN_READINESS_PATH?.trim();
  const generationId = params.generationId ?? process.env.FASED_GENERATION_ID?.trim();
  if (!lockPath || !outputPath || !generationId || !DIGEST.test(generationId)) {
    throw new Error("managed plugin readiness identity is incomplete");
  }
  const lock = readCanonicalPluginLock(lockPath);
  const managedCodeRoot = process.env.FASED_PLUGIN_CODE_ROOT?.trim();
  if (managedCodeRoot) {
    const identityError = params.registry.diagnostics.find(
      (diagnostic) =>
        diagnostic.level === "error" &&
        diagnostic.message.startsWith("managed plugin identity rejected:"),
    );
    if (identityError) {
      throw new Error(identityError.message);
    }
    const lockedManagedIds = new Set(
      lock.entries.filter((entry) => entry.origin === "store").map((entry) => entry.id),
    );
    const unboundLoaded = params.registry.plugins.find(
      (plugin) =>
        plugin.origin === "global" &&
        plugin.status === "loaded" &&
        !lockedManagedIds.has(plugin.id),
    );
    if (unboundLoaded) {
      throw new Error(
        `managed plugin ${unboundLoaded.id} is loaded but absent from the plugin lock`,
      );
    }
  }
  const canonical = JSON.stringify(lock);
  const lockDigest = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  const loaded = new Map(params.registry.plugins.map((plugin) => [plugin.id, plugin]));
  const receipt = {
    schemaVersion: 1,
    type: "fased-plugin-readiness",
    generationId,
    lockDigest,
    entries: lock.entries.map((entry) => ({
      ...entry,
      status: loaded.get(entry.id)?.status ?? "error",
    })),
  };
  const outputDirectory = path.dirname(outputPath);
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  let temporaryFd: number | undefined;
  try {
    temporaryFd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(temporaryFd, `${JSON.stringify(receipt)}\n`);
    fs.fsyncSync(temporaryFd);
    fs.closeSync(temporaryFd);
    temporaryFd = undefined;
    fs.renameSync(temporary, outputPath);
    const directoryFd = fs.openSync(outputDirectory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch (error) {
    if (temporaryFd !== undefined) {
      try {
        fs.closeSync(temporaryFd);
      } catch {}
    }
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    throw error;
  }
}
