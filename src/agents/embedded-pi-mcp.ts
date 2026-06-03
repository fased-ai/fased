import fs from "node:fs";
import path from "node:path";
import type { FasedAgentConfig, McpServerConfig } from "../config/config.js";
import { STATE_DIR } from "../config/paths.js";
import { isRecord, resolveUserPath } from "../utils.js";

export type EmbeddedPiMcpDiagnostic = {
  pluginId: string;
  message: string;
};

export type EmbeddedPiMcpConfig = {
  mcpServers: Record<string, McpServerConfig>;
  diagnostics: EmbeddedPiMcpDiagnostic[];
};

const BUNDLE_MCP_FILENAMES = [".mcp.json"] as const;

function normalizeConfiguredMcpServers(value: unknown): Record<string, McpServerConfig> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, McpServerConfig> = {};
  for (const [serverName, server] of Object.entries(value)) {
    if (isRecord(server)) {
      result[serverName] = { ...server };
    }
  }
  return result;
}

function extractMcpServerMap(raw: unknown): Record<string, McpServerConfig> {
  if (!isRecord(raw)) {
    return {};
  }
  const nested = isRecord(raw.mcpServers)
    ? raw.mcpServers
    : isRecord(raw.servers)
      ? raw.servers
      : raw;
  return normalizeConfiguredMcpServers(nested);
}

function expandBundlePath(value: string, rootDir: string): string {
  return value.split("${CLAUDE_PLUGIN_ROOT}").join(rootDir);
}

function isExplicitRelativePath(value: string): boolean {
  return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../");
}

function normalizePathLike(value: string, baseDir: string, rootDir: string): string {
  const expanded = expandBundlePath(value, rootDir);
  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  return isExplicitRelativePath(expanded) ? path.resolve(baseDir, expanded) : expanded;
}

function absolutizeBundleMcpServer(params: {
  rootDir: string;
  baseDir: string;
  server: McpServerConfig;
}): McpServerConfig {
  const next: McpServerConfig = { ...params.server };

  if (typeof next.cwd !== "string" && typeof next.workingDirectory !== "string") {
    next.cwd = params.baseDir;
  }

  if (typeof next.command === "string") {
    next.command = normalizePathLike(next.command, params.baseDir, params.rootDir);
  }
  if (typeof next.cwd === "string") {
    next.cwd = normalizePathLike(next.cwd, params.baseDir, params.rootDir);
  }
  if (typeof next.workingDirectory === "string") {
    next.workingDirectory = normalizePathLike(
      next.workingDirectory,
      params.baseDir,
      params.rootDir,
    );
  }
  if (Array.isArray(next.args)) {
    next.args = next.args.map((entry) =>
      typeof entry === "string" ? normalizePathLike(entry, params.baseDir, params.rootDir) : entry,
    );
  }
  if (isRecord(next.env)) {
    next.env = Object.fromEntries(
      Object.entries(next.env).map(([key, value]) => [
        key,
        typeof value === "string"
          ? normalizePathLike(value, params.baseDir, params.rootDir)
          : value,
      ]),
    );
  }

  return next;
}

function readBundleMcpFile(params: {
  rootDir: string;
  fileName: string;
}): Record<string, McpServerConfig> {
  const rootDir = path.resolve(params.rootDir);
  const filePath = path.resolve(rootDir, params.fileName);
  const relative = path.relative(rootDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return {};
  }
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  const servers = extractMcpServerMap(raw);
  const baseDir = path.dirname(filePath);
  return Object.fromEntries(
    Object.entries(servers).map(([serverName, server]) => [
      serverName,
      absolutizeBundleMcpServer({ rootDir, baseDir, server }),
    ]),
  );
}

function resolveEnabledPluginRootCandidates(params: {
  workspaceDir: string;
  cfg?: FasedAgentConfig;
  pluginId: string;
}): string[] {
  const installPath = params.cfg?.plugins?.installs?.[params.pluginId]?.installPath;
  return [
    ...(typeof installPath === "string" && installPath.trim()
      ? [resolveUserPath(installPath.trim())]
      : []),
    path.join(params.workspaceDir, ".fased", "extensions", params.pluginId),
    path.join(STATE_DIR, "extensions", params.pluginId),
  ];
}

function loadEnabledBundleMcpConfig(params: {
  workspaceDir: string;
  cfg?: FasedAgentConfig;
}): EmbeddedPiMcpConfig {
  const diagnostics: EmbeddedPiMcpDiagnostic[] = [];
  const mcpServers: Record<string, McpServerConfig> = {};
  const entries = params.cfg?.plugins?.entries ?? {};

  for (const [pluginId, entry] of Object.entries(entries)) {
    if (entry?.enabled !== true) {
      continue;
    }
    for (const rootDir of resolveEnabledPluginRootCandidates({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      pluginId,
    })) {
      if (!fs.existsSync(rootDir)) {
        continue;
      }
      for (const fileName of BUNDLE_MCP_FILENAMES) {
        try {
          Object.assign(mcpServers, readBundleMcpFile({ rootDir, fileName }));
        } catch (error) {
          diagnostics.push({
            pluginId,
            message: `failed to read bundle MCP config ${fileName}: ${String(error)}`,
          });
        }
      }
      break;
    }
  }

  return { mcpServers, diagnostics };
}

export function loadEmbeddedPiMcpConfig(params: {
  workspaceDir: string;
  cfg?: FasedAgentConfig;
}): EmbeddedPiMcpConfig {
  const bundleMcp = loadEnabledBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const configuredMcp = normalizeConfiguredMcpServers(params.cfg?.mcp?.servers);

  return {
    // Owner-managed config overrides bundle defaults.
    mcpServers: {
      ...bundleMcp.mcpServers,
      ...configuredMcp,
    },
    diagnostics: bundleMcp.diagnostics,
  };
}
