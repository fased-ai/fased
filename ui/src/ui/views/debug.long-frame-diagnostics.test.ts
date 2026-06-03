import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DebugProps } from "./debug.ts";

type LitTemplateLike = {
  strings?: ArrayLike<string>;
  values?: unknown[];
};

function flattenTemplateText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => flattenTemplateText(entry)).join(" ");
  }
  if (value && typeof value === "object") {
    const template = value as LitTemplateLike;
    if (template.strings && Array.isArray(template.values)) {
      const parts: string[] = [];
      const strings = Array.from(template.strings);
      for (const [index, chunk] of strings.entries()) {
        parts.push(chunk);
        if (index < template.values.length) {
          parts.push(flattenTemplateText(template.values[index]));
        }
      }
      return parts.join(" ");
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  if (typeof value === "function" || value == null || typeof value === "boolean") {
    return "";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }
  return "";
}

function normalizeRenderedText(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBetween(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = value.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return value.slice(startIndex, endIndex);
}

function createDebugProps(overrides: Partial<DebugProps> = {}): DebugProps {
  return {
    loading: false,
    status: {},
    health: {},
    models: [],
    heartbeat: {},
    eventLog: [],
    methods: ["status"],
    callMethod: "status",
    callParams: "{}",
    callResult: null,
    callError: null,
    adminRpcBusy: null,
    adminRpcResult: null,
    adminRpcError: null,
    adminChatSessionKey: "main",
    adminChatMessage: "",
    adminPushNodeId: "",
    adminPushTitle: "",
    adminPushBody: "",
    adminWebAccountId: "",
    onCallMethodChange: () => undefined,
    onCallParamsChange: () => undefined,
    onAdminChatSessionKeyChange: () => undefined,
    onAdminChatMessageChange: () => undefined,
    onAdminPushNodeIdChange: () => undefined,
    onAdminPushTitleChange: () => undefined,
    onAdminPushBodyChange: () => undefined,
    onAdminWebAccountIdChange: () => undefined,
    onRefresh: () => undefined,
    onCall: () => undefined,
    onAdminRpcAction: () => undefined,
    ...overrides,
  };
}

describe("Lane 7 long-frame diagnostics debug visibility", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    vi.stubGlobal("navigator", { language: "en-US" });
  });

  it("renders only the bounded latest diagnostic rows for long-frame-style events", async () => {
    const { renderDebug } = await import("./debug.ts");
    const events = Array.from({ length: 12 }, (_, index) => ({
      seq: index + 1,
      ts: 1770000000000 + index * 1000,
      type: "message.processed" as const,
      channel: "control-ui",
      outcome: "completed" as const,
      reason: "long-frame",
      durationMs: 70 + index,
    }));

    const text = normalizeRenderedText(
      flattenTemplateText(
        renderDebug(
          createDebugProps({
            diagnosticsStability: {
              generatedAt: "2026-05-06T00:00:00.000Z",
              capacity: 32,
              count: events.length,
              dropped: 4,
              firstSeq: 1,
              lastSeq: 12,
              events,
              summary: {
                byType: { "message.processed": events.length },
                sessions: { stuck: 0, maxQueueDepth: 2 },
                webhooks: { received: 0, processed: 0, errors: 0 },
              },
            },
          }),
        ),
      ),
    );
    const diagnosticCard = extractBetween(text, "Diagnostic Stability", "Memory Repair Preview");

    expect(diagnosticCard).toContain("12 events");
    expect(diagnosticCard).toContain("32 capacity");
    expect(diagnosticCard).toContain("4 dropped");
    expect(diagnosticCard).toMatch(/message\.processed\s*:\s*12/u);
    expect(diagnosticCard).toContain("seq 12");
    expect(diagnosticCard).toContain("duration 81ms");
    expect(diagnosticCard).toContain("seq 5");
    expect(diagnosticCard).not.toContain("seq 4");
    expect(diagnosticCard).not.toContain("duration 73ms");
  });
});
