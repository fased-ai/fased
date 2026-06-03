import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { FasedAgentConfig } from "../config/config.js";
import {
  buildFileEntry,
  chunkMarkdown,
  isMemoryPath,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  normalizeRelPath,
} from "./internal.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySyncProgressUpdate,
} from "./types.js";

const SNIPPET_MAX_CHARS = 700;

type FilesystemMemorySnapshot = {
  files: number;
  chunks: number;
};

export class FilesystemMemorySearchManager implements MemorySearchManager {
  private snapshot: FilesystemMemorySnapshot = { files: 0, chunks: 0 };

  private constructor(
    private readonly cfg: FasedAgentConfig,
    private readonly agentId: string,
    private readonly workspaceDir: string,
    private readonly settings: ResolvedMemorySearchConfig,
    private readonly unavailableReason: string,
  ) {}

  static async create(params: {
    cfg: FasedAgentConfig;
    agentId: string;
    unavailableReason: string;
  }): Promise<FilesystemMemorySearchManager | null> {
    const settings = resolveMemorySearchConfig(params.cfg, params.agentId);
    if (!settings) {
      return null;
    }
    const manager = new FilesystemMemorySearchManager(
      params.cfg,
      params.agentId,
      resolveAgentWorkspaceDir(params.cfg, params.agentId),
      settings,
      params.unavailableReason,
    );
    await manager.refreshSnapshot();
    return manager;
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number },
  ): Promise<MemorySearchResult[]> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return [];
    }
    const files = await this.listFiles();
    const rows: MemorySearchResult[] = [];
    for (const absPath of files) {
      const entry = await buildFileEntry(absPath, this.workspaceDir);
      if (!entry) {
        continue;
      }
      const content = await fs.readFile(entry.absPath, "utf-8");
      for (const chunk of chunkMarkdown(content, this.settings.chunking)) {
        const score = scoreChunk(queryTokens, chunk.text);
        if (score <= 0 || score < (opts?.minScore ?? 0)) {
          continue;
        }
        rows.push({
          path: entry.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          score,
          snippet: truncateSnippet(chunk.text),
          source: "memory",
          citation: `${entry.path}#L${chunk.startLine}-L${chunk.endLine}`,
        });
      }
    }
    rows.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    return rows.slice(0, Math.max(1, opts?.maxResults ?? 5));
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const relPath = normalizeRelPath(params.relPath);
    const absPath = path.resolve(this.workspaceDir, relPath);
    const allowed = await this.isAllowedReadPath(relPath, absPath);
    if (!allowed) {
      throw new Error("path required");
    }
    let content = "";
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch (err) {
      if (isMissingPathError(err)) {
        return { text: "", path: relPath };
      }
      throw err;
    }
    if (!params.from && !params.lines) {
      return { text: content, path: relPath };
    }
    const lines = content.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    return { text: lines.slice(start - 1, start - 1 + count).join("\n"), path: relPath };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "builtin",
      provider: "filesystem",
      model: "keyword",
      requestedProvider: this.settings.provider,
      files: this.snapshot.files,
      chunks: this.snapshot.chunks,
      dirty: false,
      workspaceDir: this.workspaceDir,
      sources: ["memory"],
      extraPaths: this.settings.extraPaths,
      sourceCounts: [
        { source: "memory", files: this.snapshot.files, chunks: this.snapshot.chunks },
      ],
      fts: { enabled: true, available: true },
      vector: { enabled: false, available: false },
      cache: { enabled: false },
      custom: {
        searchMode: "filesystem-keyword-fallback",
        sqliteUnavailable: true,
        sqliteUnavailableReason: this.unavailableReason,
      },
    };
  }

  async sync(params?: { progress?: (update: MemorySyncProgressUpdate) => void }): Promise<void> {
    await this.refreshSnapshot();
    params?.progress?.({ completed: this.snapshot.files, total: this.snapshot.files });
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return {
      ok: false,
      error: "SQLite unavailable; filesystem keyword memory fallback is active.",
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return false;
  }

  async close(): Promise<void> {}

  private async refreshSnapshot(): Promise<void> {
    const files = await this.listFiles();
    let chunks = 0;
    for (const absPath of files) {
      try {
        chunks += chunkMarkdown(await fs.readFile(absPath, "utf-8"), this.settings.chunking).length;
      } catch {}
    }
    this.snapshot = { files: files.length, chunks };
  }

  private async listFiles(): Promise<string[]> {
    if (!this.settings.sources.includes("memory")) {
      return [];
    }
    return await listMemoryFiles(this.workspaceDir, this.settings.extraPaths);
  }

  private async isAllowedReadPath(relPath: string, absPath: string): Promise<boolean> {
    if (isMemoryPath(relPath) && isPathInside(absPath, this.workspaceDir)) {
      return absPath.endsWith(".md");
    }
    for (const extraPath of normalizeExtraMemoryPaths(
      this.workspaceDir,
      this.settings.extraPaths,
    )) {
      if (!isPathInside(absPath, extraPath) && absPath !== extraPath) {
        continue;
      }
      try {
        const stat = await fs.lstat(absPath);
        if (!stat.isSymbolicLink() && stat.isFile() && absPath.endsWith(".md")) {
          return true;
        }
      } catch {}
    }
    return false;
  }
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9_]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  );
}

function scoreChunk(queryTokens: readonly string[], text: string): number {
  const lower = text.toLowerCase();
  const textTokens = tokenize(lower);
  if (textTokens.length === 0) {
    return 0;
  }
  let hits = 0;
  for (const token of queryTokens) {
    if (textTokens.includes(token) || lower.includes(token)) {
      hits += 1;
    }
  }
  return hits / queryTokens.length;
}

function truncateSnippet(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= SNIPPET_MAX_CHARS) {
    return compact;
  }
  return `${compact.slice(0, SNIPPET_MAX_CHARS - 1)}…`;
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissingPathError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
