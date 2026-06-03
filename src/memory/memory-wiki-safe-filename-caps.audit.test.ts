import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf-8");
}

async function pathExists(relativePath: string): Promise<boolean> {
  return Boolean(await fs.stat(path.join(repoRoot, relativePath)).catch(() => null));
}

describe("Lane 5 memory wiki safe filename caps audit", () => {
  it("maps upstream memory-wiki filename caps to absent package and Fased memory writers", async () => {
    expect(await pathExists("extensions/memory-wiki/src/markdown.ts")).toBe(false);
    expect(await pathExists("extensions/memory-wiki/src/markdown.test.ts")).toBe(false);
    expect(await pathExists("src/memory/memory-wiki.ts")).toBe(false);
    expect(await pathExists("src/memory/wiki.ts")).toBe(true);

    const wikiSource = await readSource("src/memory/wiki.ts");
    expect(wikiSource).toContain("MAX_MEMORY_WIKI_FILENAME_BYTES");
    expect(wikiSource).toContain("readFileWithinRoot");
    expect(wikiSource).toContain("writeFileWithinRoot");
    expect(wikiSource).toContain('path.join(stateDir, "memory-wiki"');

    const sessionMemorySource = await readSource("src/hooks/bundled/session-memory/handler.ts");
    expect(sessionMemorySource).toContain("resolveAvailableMemoryFilename");
    expect(sessionMemorySource).toContain("const base = `${params.dateStr}-${params.slug}`;");
    expect(sessionMemorySource).toContain("await writeFileWithinRoot({");
    expect(sessionMemorySource).toContain("rootDir: memoryDir");
    expect(sessionMemorySource).toContain("relativePath: filename");
    expect(sessionMemorySource).toContain("data: entry");
    expect(sessionMemorySource).not.toContain(
      'await fs.writeFile(memoryFilePath, entry, "utf-8");',
    );
    expect(sessionMemorySource).toContain("allowLlmSlug");
    expect(sessionMemorySource).not.toContain("MAX_WIKI_SAFE_WRITE_FILENAME_COMPONENT_BYTES");
    expect(sessionMemorySource).not.toContain(".fallback.tmp");

    const slugSource = await readSource("src/hooks/llm-slug-generator.ts");
    expect(slugSource).toContain('.replace(/[^a-z0-9-]/g, "-")');
    expect(slugSource).toContain(".slice(0, 30)");
    expect(slugSource).not.toContain("Buffer.byteLength");

    const qmdSource = await readSource("src/memory/qmd-manager.ts");
    expect(qmdSource).toContain(
      'const target = path.join(exportDir, `${path.basename(sessionFile, ".jsonl")}.md`);',
    );
    expect(qmdSource).toContain(
      'await fs.writeFile(target, this.renderSessionMarkdown(entry), "utf-8");',
    );
    expect(qmdSource).toContain("sanitizeCollectionNameSegment");
    expect(qmdSource).not.toContain("MAX_WIKI_SAFE_WRITE_FILENAME_COMPONENT_BYTES");
    expect(qmdSource).not.toContain(".fallback.tmp");
  });

  it("maps Fased filesystem safe-write helpers without runtime cap changes", async () => {
    const fsSafeSource = await readSource("src/infra/fs-safe.ts");
    expect(fsSafeSource).toContain("export async function writeFileWithinRoot");
    expect(fsSafeSource).toContain("OPEN_WRITE_FLAGS");
    expect(fsSafeSource).toContain("assertNoPathAliasEscape");
    expect(fsSafeSource).toContain("sameFileIdentity");
    expect(fsSafeSource).toContain("hardlinked path not allowed");
    expect(fsSafeSource).toContain("path escapes root");
    expect(fsSafeSource).not.toContain("createWikiPageFilename");
    expect(fsSafeSource).not.toContain(".fallback.tmp");

    const queuedWriterSource = await readSource("src/agents/queued-file-writer.ts");
    expect(queuedWriterSource).toContain('fs.appendFile(filePath, line, "utf8")');
    expect(queuedWriterSource).not.toContain(".fallback.tmp");
  });

  it("keeps QMD scope and active-memory channel guards in the future runtime decision", async () => {
    const qmdScopeSource = await readSource("src/memory/qmd-scope.ts");
    expect(qmdScopeSource).toContain("isQmdScopeAllowed");
    expect(qmdScopeSource).toContain("resolveQmdScopeDenial");
    expect(qmdScopeSource).toContain('normalized.startsWith("subagent:")');

    const memoryToolSource = await readSource("src/agents/tools/memory-tool.ts");
    expect(memoryToolSource).toContain("resolveMemoryToolScopeDenial");
    expect(memoryToolSource).toContain("buildMemorySearchUnavailableResult");
    expect(memoryToolSource).toContain("deriveChatTypeFromSessionKey");

    const filesystemSource = await readSource("src/memory/filesystem-manager.ts");
    expect(filesystemSource).toContain("readFile(params");
    expect(filesystemSource).toContain("isAllowedReadPath");
    expect(filesystemSource).not.toContain("writeFile");
    expect(filesystemSource).not.toContain(".fallback.tmp");
  });

  it.skip("caps Fased session-memory filenames with a safe-write temporary suffix budget", () => {});

  it.skip("caps QMD session-export filenames without changing scope or retention semantics", () => {});

  it.skip("uses a Fased-owned filename cap helper instead of importing memory-wiki runtime code", () => {});
});
