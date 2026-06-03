import fs from "node:fs";
import path from "node:path";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { FasedAgentConfig } from "../config/config.js";
import { applyMergePatch } from "../config/merge-patch.js";
import { applyPiCompactionSettingsFromConfig } from "./pi-settings.js";

export const DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY = "sanitize";
export const SANITIZED_PROJECT_PI_KEYS = ["shellPath", "shellCommandPrefix"] as const;

export type EmbeddedPiProjectSettingsPolicy = "trusted" | "sanitize" | "ignore";

type PiSettingsSnapshot = ReturnType<SettingsManager["getGlobalSettings"]>;

function sanitizeProjectSettings(settings: PiSettingsSnapshot): PiSettingsSnapshot {
  const sanitized = { ...settings };
  // Never allow workspace-local settings to override shell execution behavior.
  for (const key of SANITIZED_PROJECT_PI_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

export function resolveEmbeddedPiProjectSettingsPolicy(
  cfg?: FasedAgentConfig,
): EmbeddedPiProjectSettingsPolicy {
  const raw = cfg?.agents?.defaults?.embeddedPi?.projectSettingsPolicy;
  if (raw === "trusted" || raw === "sanitize" || raw === "ignore") {
    return raw;
  }
  return DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY;
}

export function buildEmbeddedPiSettingsSnapshot(params: {
  globalSettings: PiSettingsSnapshot;
  pluginSettings?: PiSettingsSnapshot;
  projectSettings: PiSettingsSnapshot;
  policy: EmbeddedPiProjectSettingsPolicy;
}): PiSettingsSnapshot {
  const pluginSettings = sanitizeProjectSettings(params.pluginSettings ?? {});
  const effectiveProjectSettings =
    params.policy === "ignore"
      ? {}
      : params.policy === "sanitize"
        ? sanitizeProjectSettings(params.projectSettings)
        : params.projectSettings;
  return applyMergePatch(
    applyMergePatch(params.globalSettings, pluginSettings),
    effectiveProjectSettings,
  ) as PiSettingsSnapshot;
}

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function loadEnabledBundlePiSettingsSnapshot(params: {
  cwd: string;
  cfg?: FasedAgentConfig;
}): PiSettingsSnapshot {
  const entries = (
    params.cfg as unknown as { plugins?: { entries?: Record<string, { enabled?: boolean }> } }
  )?.plugins?.entries;
  const merged: Record<string, unknown> = {};
  if (entries) {
    for (const [pluginId, entry] of Object.entries(entries)) {
      if (entry?.enabled !== true) {
        continue;
      }
      const pluginRoot = path.join(params.cwd, ".fased", "extensions", pluginId);
      Object.assign(
        merged,
        sanitizeProjectSettings(readJsonFile(path.join(pluginRoot, "settings.json"))),
      );
      const mcp = readJsonFile(path.join(pluginRoot, ".mcp.json"));
      const servers =
        mcp.mcpServers && typeof mcp.mcpServers === "object" && !Array.isArray(mcp.mcpServers)
          ? (mcp.mcpServers as Record<string, unknown>)
          : undefined;
      if (servers) {
        const resolvedServers: Record<string, unknown> = {};
        const resolvedRoot = fs.realpathSync.native?.(pluginRoot) ?? fs.realpathSync(pluginRoot);
        for (const [name, server] of Object.entries(servers)) {
          if (!server || typeof server !== "object" || Array.isArray(server)) {
            resolvedServers[name] = server;
            continue;
          }
          const record = { ...(server as Record<string, unknown>) };
          if (Array.isArray(record.args)) {
            record.args = record.args.map((arg) =>
              typeof arg === "string" && arg.startsWith("./") ? path.join(resolvedRoot, arg) : arg,
            );
          }
          record.cwd = resolvedRoot;
          resolvedServers[name] = record;
        }
        const existingServers = merged.mcpServers as Record<string, unknown> | undefined;
        merged.mcpServers = {
          ...existingServers,
          ...resolvedServers,
        };
      }
    }
  }
  const topLevelServers = (params.cfg as unknown as { mcp?: { servers?: Record<string, unknown> } })
    ?.mcp?.servers;
  if (topLevelServers) {
    const existingServers = merged.mcpServers as Record<string, unknown> | undefined;
    merged.mcpServers = {
      ...existingServers,
      ...topLevelServers,
    };
  }
  return merged as PiSettingsSnapshot;
}

export function createEmbeddedPiSettingsManager(params: {
  cwd: string;
  agentDir: string;
  cfg?: FasedAgentConfig;
}): SettingsManager {
  const fileSettingsManager = SettingsManager.create(params.cwd, params.agentDir);
  const policy = resolveEmbeddedPiProjectSettingsPolicy(params.cfg);
  if (policy === "trusted") {
    return fileSettingsManager;
  }
  const settings = buildEmbeddedPiSettingsSnapshot({
    globalSettings: fileSettingsManager.getGlobalSettings(),
    pluginSettings: loadEnabledBundlePiSettingsSnapshot({ cwd: params.cwd, cfg: params.cfg }),
    projectSettings: fileSettingsManager.getProjectSettings(),
    policy,
  });
  return SettingsManager.inMemory(settings);
}

export function createPreparedEmbeddedPiSettingsManager(params: {
  cwd: string;
  agentDir: string;
  cfg?: FasedAgentConfig;
}): SettingsManager {
  const settingsManager = createEmbeddedPiSettingsManager(params);
  applyPiCompactionSettingsFromConfig({
    settingsManager,
    cfg: params.cfg,
  });
  return settingsManager;
}
