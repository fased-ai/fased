import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const gatewayDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(gatewayDir, "..");
const repoRoot = resolve(gatewayDir, "../..");

function readSource(relativePath: string): string {
  return readFileSync(join(srcDir, relativePath), "utf8");
}

function readRepoSource(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function sourceExists(relativePath: string): boolean {
  return existsSync(join(srcDir, relativePath));
}

describe("status/session runtime labels audit", () => {
  it("maps ed4ed5aead to current Fased status CLI session labels", () => {
    const statusCommand = readSource("commands/status.command.ts");
    const statusSummary = readSource("commands/status.summary.ts");
    const statusTypes = readSource("commands/status.types.ts");

    const sessionsTableStart = statusCommand.indexOf('runtime.log(theme.heading("Sessions"))');
    const sessionsTableBlock = statusCommand.slice(sessionsTableStart, sessionsTableStart + 1400);

    expect(sessionsTableStart).toBeGreaterThan(-1);
    expect(sessionsTableBlock).toContain('{ key: "Kind", header: "Kind"');
    expect(sessionsTableBlock).toContain('{ key: "Age", header: "Age"');
    expect(sessionsTableBlock).toContain('{ key: "Model", header: "Model"');
    expect(sessionsTableBlock).toContain('{ key: "Tokens", header: "Tokens"');
    expect(sessionsTableBlock).not.toContain("Runtime");

    expect(statusTypes).toContain("model: string | null;");
    expect(statusTypes).not.toContain("runtime?:");
    expect(statusTypes).not.toContain("runtime: string | null");

    expect(statusSummary).toContain("resolveSessionModelRef(cfg, entry");
    expect(statusSummary).toContain("flags: buildFlags(entry)");
    expect(statusSummary).not.toContain("resolveSessionRuntimeLabel");
    expect(statusSummary).not.toContain("resolveAgentRuntimeMetadata");
  });

  it("maps 3544ef0afa to current Fased sessions CLI output and JSON shape", () => {
    const sessionsCommand = readSource("commands/sessions.ts");
    const sessionsTable = readSource("commands/sessions-table.ts");

    const headerStart = sessionsCommand.indexOf("const header = [");
    const headerBlock = sessionsCommand.slice(headerStart, headerStart + 900);
    const jsonStart = sessionsCommand.indexOf("sessions: rows.map");
    const jsonBlock = sessionsCommand.slice(jsonStart, jsonStart + 900);

    expect(headerStart).toBeGreaterThan(-1);
    expect(headerBlock).toContain('"Kind".padEnd(KIND_PAD)');
    expect(headerBlock).toContain('"Model".padEnd(SESSION_MODEL_PAD)');
    expect(headerBlock).toContain('"Tokens (ctx %)".padEnd(TOKENS_PAD)');
    expect(headerBlock).not.toContain("RUNTIME_PAD");
    expect(headerBlock).not.toContain("Runtime");

    expect(jsonStart).toBeGreaterThan(-1);
    expect(jsonBlock).toContain("model,");
    expect(jsonBlock).not.toContain("runtimeLabel");
    expect(jsonBlock).not.toContain("agentRuntime");
    expect(jsonBlock).not.toContain("runtime:");

    expect(sessionsTable).toContain("model?: string;");
    expect(sessionsTable).toContain("modelProvider?: string;");
    expect(sessionsTable).not.toContain("runtimeLabel");
    expect(sessionsTable).not.toContain("agentRuntime");
    expect(sourceExists("status/agent-runtime-label.ts")).toBe(false);
  });

  it("maps 7da737c67d to current Fased Control UI session card behavior", () => {
    const uiSessionsView = readRepoSource("ui/src/ui/views/sessions.ts");
    const uiSessionsController = readRepoSource("ui/src/ui/controllers/sessions.ts");
    const uiTypes = readRepoSource("ui/src/ui/types.ts");

    expect(uiSessionsView).toContain('<div class="session-card__stat-label">Kind</div>');
    expect(uiSessionsView).toContain('<div class="session-card__stat-label">Updated</div>');
    expect(uiSessionsView).toContain('<div class="session-card__stat-label">Tokens</div>');
    expect(uiSessionsView).not.toContain("session-runtime-cell");
    expect(uiSessionsView).not.toContain("agents.context.runtime");
    expect(uiSessionsView).not.toContain("resolveAgentRuntimeLabel(row.agentRuntime)");

    expect(uiTypes).toContain('export type SessionRunStatus = "running" | "done"');
    expect(uiTypes).toContain("runtimeMs?: number;");
    expect(uiTypes).toContain("modelProvider?: string;");
    expect(uiTypes).not.toContain("agentRuntime");

    expect(uiSessionsController).toContain("runtimeMs?: number;");
    expect(uiSessionsController).toContain("next.runtimeMs = runtimeMs;");
    expect(uiSessionsController).toContain("next.modelProvider = modelProvider;");
    expect(uiSessionsController).not.toContain("agentRuntime");
  });

  it("keeps session labels separate from command routing and session-tool visibility", () => {
    const chatParity = readSource("gateway/server-methods/chat.webchat-command-parity.test.ts");
    const sessionsHandlers = readSource("gateway/server-methods/sessions.ts");
    const sessionsListTool = readSource("agents/tools/sessions-list-tool.ts");

    expect(chatParity).toContain("@wallet");
    expect(chatParity).toContain("@trade");
    expect(chatParity).toContain("@offers");
    expect(chatParity).toContain("@mining");

    expect(sessionsHandlers).toContain('"sessions.list"');
    expect(sessionsHandlers).toContain("listSessionsFromStore({");
    expect(sessionsHandlers).toContain("resolveSessionModelRef(cfg, applied.entry");
    expect(sessionsHandlers).not.toContain("resolveSessionRuntimeLabel");

    expect(sessionsListTool).toContain("sessions_list");
    expect(sessionsListTool).toContain("model");
    expect(sessionsListTool).not.toContain("runtimeLabel");
  });

  it.skip("adds Fased-approved runtime labels to status CLI sessions output", () => {});

  it.skip("adds Fased-approved runtime labels to sessions CLI output without changing JSON compatibility", () => {});

  it.skip("renders Fased-approved runtime labels in the Control UI sessions surface", () => {});
});
