import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { readFileWithinRoot, writeFileWithinRoot } from "../infra/fs-safe.js";

const MAX_MEMORY_WIKI_SOURCES = 500;
const MAX_MEMORY_WIKI_SOURCE_BYTES = 512 * 1024;
const MAX_MEMORY_WIKI_EXCERPT_CHARS = 2_000;
const MAX_MEMORY_WIKI_FILENAME_BYTES = 96;

export type MemoryWikiSource = {
  title: string;
  sourcePath: string;
  pagePath: string;
  bytes: number;
};

export type MemoryWikiStatus = {
  agentId: string;
  outputDir: string;
  indexPath: string;
  sources: number;
  pages: number;
  built: boolean;
  lastBuiltAtMs?: number;
  error?: string;
};

export type MemoryWikiBuildResult = MemoryWikiStatus & {
  sourceFiles: MemoryWikiSource[];
};

function memoryWikiRoot(stateDir: string, agentId: string) {
  return path.join(stateDir, "memory-wiki", sanitizePathSegment(agentId));
}

function sanitizePathSegment(raw: string): string {
  const ascii = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return trimUtf8Bytes(ascii || "memory", MAX_MEMORY_WIKI_FILENAME_BYTES);
}

function trimUtf8Bytes(raw: string, maxBytes: number): string {
  let next = raw;
  while (Buffer.byteLength(next, "utf8") > maxBytes && next.length > 0) {
    next = next.slice(0, -1);
  }
  return next || "memory";
}

function firstHeading(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/g)) {
    const match = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return null;
}

function excerpt(markdown: string): string {
  return markdown
    .split(/\r?\n/g)
    .filter((line) => line.trim())
    .slice(0, 40)
    .join("\n")
    .slice(0, MAX_MEMORY_WIKI_EXCERPT_CHARS);
}

function markdownLabel(raw: string): string {
  return (
    raw
      .replace(/[[\]\\]/g, "\\$&")
      .replace(/\r?\n/g, " ")
      .trim() || "Memory"
  );
}

async function listMemorySourcePaths(workspaceDir: string): Promise<string[]> {
  const sources = ["MEMORY.md"];
  const memoryDir = path.join(workspaceDir, "memory");
  const entries = await fs.readdir(memoryDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }
    sources.push(path.join("memory", entry.name));
    if (sources.length >= MAX_MEMORY_WIKI_SOURCES) {
      break;
    }
  }
  return sources;
}

async function readMemorySource(workspaceDir: string, relativePath: string) {
  const file = await readFileWithinRoot({
    rootDir: workspaceDir,
    relativePath,
    maxBytes: MAX_MEMORY_WIKI_SOURCE_BYTES,
  }).catch(() => null);
  if (!file) {
    return null;
  }
  const content = file.buffer.toString("utf8");
  return {
    relativePath,
    bytes: file.stat.size,
    content,
    title: firstHeading(content) ?? path.basename(relativePath, ".md"),
  };
}

function renderSourcePage(params: { title: string; sourcePath: string; content: string }) {
  return [
    `# ${params.title}`,
    "",
    `Source: \`${params.sourcePath}\``,
    "",
    "## Extract",
    "",
    excerpt(params.content),
    "",
  ].join("\n");
}

function renderIndex(params: { agentId: string; builtAt: string; sources: MemoryWikiSource[] }) {
  return [
    `# Memory Wiki: ${params.agentId}`,
    "",
    `Built: ${params.builtAt}`,
    "",
    "This export is generated from Agent memory Markdown files. It is a read-only compiled view; edit the source memory files, then rebuild.",
    "",
    "## Sources",
    "",
    ...params.sources.map(
      (source) =>
        `- [${markdownLabel(source.title)}](${source.pagePath}) - \`${source.sourcePath}\`, ${source.bytes} bytes`,
    ),
    "",
  ].join("\n");
}

export async function buildMemoryWiki(params: {
  cfg: FasedAgentConfig;
  agentId: string;
}): Promise<MemoryWikiBuildResult> {
  const workspaceDir = path.resolve(resolveAgentWorkspaceDir(params.cfg, params.agentId));
  const stateDir = path.resolve(resolveStateDir(process.env));
  const outputDir = memoryWikiRoot(stateDir, params.agentId);
  await fs.mkdir(outputDir, { recursive: true });
  const sourcePaths = await listMemorySourcePaths(workspaceDir);
  const sourceFiles: MemoryWikiSource[] = [];
  const seenPageNames = new Set<string>();
  for (const sourcePath of sourcePaths) {
    const source = await readMemorySource(workspaceDir, sourcePath);
    if (!source) {
      continue;
    }
    let slug = sanitizePathSegment(source.title);
    let pageName = `${slug}.md`;
    let suffix = 2;
    while (seenPageNames.has(pageName)) {
      slug = sanitizePathSegment(`${source.title}-${suffix}`);
      pageName = `${slug}.md`;
      suffix += 1;
    }
    seenPageNames.add(pageName);
    const pagePath = `sources/${pageName}`;
    await writeFileWithinRoot({
      rootDir: outputDir,
      relativePath: pagePath,
      data: renderSourcePage({
        title: source.title,
        sourcePath,
        content: source.content,
      }),
      mkdir: true,
    });
    sourceFiles.push({
      title: source.title,
      sourcePath,
      pagePath,
      bytes: source.bytes,
    });
  }

  const builtAt = new Date();
  await writeFileWithinRoot({
    rootDir: outputDir,
    relativePath: "index.md",
    data: renderIndex({
      agentId: params.agentId,
      builtAt: builtAt.toISOString(),
      sources: sourceFiles,
    }),
    mkdir: true,
  });
  return {
    agentId: params.agentId,
    outputDir,
    indexPath: path.join(outputDir, "index.md"),
    sources: sourceFiles.length,
    pages: sourceFiles.length + 1,
    built: true,
    lastBuiltAtMs: builtAt.getTime(),
    sourceFiles,
  };
}

export async function getMemoryWikiStatus(params: {
  cfg: FasedAgentConfig;
  agentId: string;
}): Promise<MemoryWikiStatus> {
  const stateDir = path.resolve(resolveStateDir(process.env));
  const outputDir = memoryWikiRoot(stateDir, params.agentId);
  const indexPath = path.join(outputDir, "index.md");
  const stat = await fs.stat(indexPath).catch(() => null);
  let pages = 0;
  if (stat?.isFile()) {
    const sourceDir = path.join(outputDir, "sources");
    const sourcePages = await fs.readdir(sourceDir).catch(() => []);
    pages = 1 + sourcePages.filter((entry) => entry.toLowerCase().endsWith(".md")).length;
  }
  return {
    agentId: params.agentId,
    outputDir,
    indexPath,
    sources: pages > 0 ? pages - 1 : 0,
    pages,
    built: Boolean(stat?.isFile()),
    ...(stat?.mtimeMs ? { lastBuiltAtMs: Math.floor(stat.mtimeMs) } : {}),
  };
}
