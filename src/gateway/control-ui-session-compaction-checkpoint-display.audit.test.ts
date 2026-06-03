import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../../ui/src/ui/types.js";
import type { SessionsProps } from "../../ui/src/ui/views/sessions.js";
import {
  describeCheckpointBranchIsolation,
  describeCheckpointRestoreIsolation,
} from "./session-compaction-isolation.js";

const gatewayDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(gatewayDir, "..");
const repoRoot = resolve(gatewayDir, "../..");

function readSource(relativePath: string): string {
  return readFileSync(join(srcDir, relativePath), "utf8");
}

function readRepoSource(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function buildResult(session: SessionsListResult["sessions"][number]): SessionsListResult {
  return {
    ts: Date.now(),
    path: "(multiple)",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [session],
  };
}

function buildProps(result: SessionsListResult): SessionsProps {
  return {
    loading: false,
    result,
    error: null,
    search: "",
    activeMinutes: "",
    limit: "120",
    includeGlobal: false,
    includeUnknown: false,
    basePath: "",
    onFiltersChange: () => undefined,
    onRefresh: () => undefined,
    onPatch: () => undefined,
    onDelete: () => undefined,
    onBranchCheckpoint: () => undefined,
    onRestoreCheckpoint: () => undefined,
  };
}

type TemplateLike = {
  strings: readonly string[];
  values: readonly unknown[];
};

function isTemplateLike(value: unknown): value is TemplateLike {
  if (!value || typeof value !== "object") {
    return false;
  }
  const maybeTemplate = value as { strings?: unknown; values?: unknown };
  return Array.isArray(maybeTemplate.strings) && Array.isArray(maybeTemplate.values);
}

function collectTemplateText(value: unknown, parts: string[] = []): string {
  if (isTemplateLike(value)) {
    parts.push(...value.strings);
    for (const nested of value.values) {
      collectTemplateText(nested, parts);
    }
    return parts.join(" ");
  }
  if (Array.isArray(value)) {
    for (const nested of value) {
      collectTemplateText(nested, parts);
    }
    return parts.join(" ");
  }
  if (typeof value === "string" || typeof value === "number") {
    parts.push(String(value));
  }
  return parts.join(" ");
}

function installBrowserStorage(): void {
  const storage = new Map<string, string>();
  const localStorage = {
    get length() {
      return storage.size;
    },
    getItem: (key: string) => storage.get(key) ?? null,
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => storage.clear(),
  };
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  globals.localStorage = localStorage;
  globals.litDisableBundleWarning = true;
}

describe("Lane 6 Control UI session compaction checkpoint display audit", () => {
  it("maps the current Fased session-card checkpoint display surface", () => {
    const uiSessionsView = readRepoSource("ui/src/ui/views/sessions.ts");
    const uiSessionsController = readRepoSource("ui/src/ui/controllers/sessions.ts");
    const uiAppRender = readRepoSource("ui/src/ui/app-render.ts");
    const uiTypes = readRepoSource("ui/src/ui/types.ts");

    expect(uiTypes).toContain("export type GatewaySessionCompactionCheckpointSummary");
    expect(uiTypes).toContain("checkpointId: string;");
    expect(uiTypes).toContain(
      'reason: "manual" | "auto-threshold" | "overflow-retry" | "timeout-retry";',
    );
    expect(uiTypes).toContain("compactionCheckpointCount?: number;");
    expect(uiTypes).toContain(
      "compactionCheckpoints?: GatewaySessionCompactionCheckpointSummary[];",
    );

    expect(uiSessionsView).toContain("function formatCheckpointTokens");
    expect(uiSessionsView).toContain("const checkpoints = row.compactionCheckpoints ?? [];");
    expect(uiSessionsView).toContain('class="session-card__checkpoints"');
    expect(uiSessionsView).toContain('"1 compaction checkpoint"');
    expect(uiSessionsView).toContain("`${checkpoints.length} compaction checkpoints`");
    expect(uiSessionsView).toContain('class="session-card__checkpoint-id mono"');
    expect(uiSessionsView).toContain("checkpoint.checkpointId");
    expect(uiSessionsView).toContain("checkpoint.reason");
    expect(uiSessionsView).toContain("formatCheckpointTokens(checkpoint)");
    expect(uiSessionsView).toContain("checkpoint.summary");
    expect(uiSessionsView).toContain("onBranchCheckpoint(row.key, checkpoint.checkpointId)");
    expect(uiSessionsView).toContain("onRestoreCheckpoint(row.key, checkpoint.checkpointId)");

    expect(uiSessionsController).toContain('"sessions.compaction.branch"');
    expect(uiSessionsController).toContain('"sessions.compaction.restore"');
    expect(uiSessionsController).toContain(
      'Create a new session from checkpoint "${checkpointId}"?',
    );
    expect(uiSessionsController).toContain(
      'Restore session "${key}" from checkpoint "${checkpointId}"?',
    );

    expect(uiAppRender).toContain("onBranchCheckpoint: (key, checkpointId)");
    expect(uiAppRender).toContain("branchSessionCheckpoint(state, key, checkpointId)");
    expect(uiAppRender).toContain("onRestoreCheckpoint: (key, checkpointId)");
    expect(uiAppRender).toContain("restoreSessionCheckpoint(state, key, checkpointId)");
  });

  it("builds checkpoint display through the executable UI template path", async () => {
    installBrowserStorage();
    const { renderSessions } = await import("../../ui/src/ui/views/sessions.js");

    const templateText = collectTemplateText(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            compactionCheckpointCount: 1,
            compactionCheckpoints: [
              {
                checkpointId: "checkpoint-1",
                createdAt: Date.now(),
                reason: "manual",
                tokensBefore: 1200,
                tokensAfter: 600,
                summary: "Compacted after a long market scan.",
              },
            ],
          }),
        ),
      }),
    );

    expect(templateText).toContain("1 compaction checkpoint");
    expect(templateText).toContain("checkpoint-1");
    expect(templateText).toContain("manual");
    expect(templateText).toContain("tokens");
    expect(templateText).toContain("1,200 -> 600");
    expect(templateText).toContain("Compacted after a long market scan.");
    expect(templateText).toContain("Branch");
    expect(templateText).toContain("Restore");
  });

  it("preserves checkpoint branch/restore isolation and non-session UI boundaries", () => {
    const branchIsolation = describeCheckpointBranchIsolation();
    const restoreIsolation = describeCheckpointRestoreIsolation();
    const chatParity = readSource("gateway/server-methods/chat.webchat-command-parity.test.ts");
    const sessionsListTool = readSource("agents/tools/sessions-list-tool.ts");
    const sessionsHistoryTool = readSource("agents/tools/sessions-history-tool.ts");
    const walletBoundary = readSource("wallet/chat-command.test.ts");

    expect([
      ...branchIsolation.operatorSessionEventPhases,
      ...restoreIsolation.operatorSessionEventPhases,
    ]).toEqual(["checkpoint-branch-source", "checkpoint-branch", "checkpoint-restore"]);
    expect(branchIsolation.channelDeliveryTouched).toBe(false);
    expect(branchIsolation.walletActionRoutingTouched).toBe(false);
    expect(branchIsolation.sessionToolVisibilityTouched).toBe(false);
    expect(restoreIsolation.channelDeliveryTouched).toBe(false);
    expect(restoreIsolation.walletActionRoutingTouched).toBe(false);
    expect(restoreIsolation.sessionToolVisibilityTouched).toBe(false);

    expect(chatParity).toContain("@wallet");
    expect(chatParity).toContain("@trade");
    expect(chatParity).toContain("@offers");
    expect(chatParity).toContain("@mining");
    expect(walletBoundary).toContain("@wallet");

    expect(sessionsListTool).toContain("createSessionVisibilityGuard");
    expect(sessionsHistoryTool).toContain("createSessionVisibilityGuard");
    expect(`${sessionsListTool}\n${sessionsHistoryTool}`).not.toContain(
      "compactionCheckpointDisplay",
    );
  });

  it.skip("adopts richer checkpoint table/card layout only after a Fased UI runtime review", () => {});
});
