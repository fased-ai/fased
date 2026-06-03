import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";

vi.mock("../../config/config.js", () => {
  return {
    loadConfig: vi.fn(() => ({
      agents: {
        list: [{ id: "main" }, { id: "opus" }],
      },
      session: {},
    })),
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: vi.fn(() => ({ storePath: "(multiple)", store: {} })),
  };
});

vi.mock("../../cron/store.js", () => {
  return {
    resolveCronStorePath: vi.fn(() => "/tmp/fased-cron/jobs.json"),
    loadCronStore: vi.fn(async () => ({ version: 1, jobs: [] })),
  };
});

vi.mock("../../cron/run-log.js", () => {
  return {
    readCronRunLogEntriesPageAll: vi.fn(async () => ({
      entries: [],
      total: 0,
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    })),
  };
});

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    discoverAllSessions: vi.fn(async (params?: { agentId?: string }) => {
      if (params?.agentId === "main") {
        return [
          {
            sessionId: "s-main",
            sessionFile: "/tmp/agents/main/sessions/s-main.jsonl",
            mtime: 100,
            firstUserMessage: "hello",
          },
        ];
      }
      if (params?.agentId === "opus") {
        return [
          {
            sessionId: "s-opus",
            sessionFile: "/tmp/agents/opus/sessions/s-opus.jsonl",
            mtime: 200,
            firstUserMessage: "hi",
          },
        ];
      }
      return [];
    }),
    loadSessionCostSummary: vi.fn(async () => ({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    })),
    loadSessionUsageTimeSeries: vi.fn(async () => ({
      sessionId: "s-opus",
      points: [],
    })),
    loadSessionLogs: vi.fn(async () => []),
  };
});

import { readCronRunLogEntriesPageAll } from "../../cron/run-log.js";
import { loadCronStore } from "../../cron/store.js";
import {
  discoverAllSessions,
  loadSessionCostSummary,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
} from "../../infra/session-cost-usage.js";
import { loadCombinedSessionStoreForGateway } from "../session-utils.js";
import { usageHandlers } from "./usage.js";

async function runSessionsUsage(params: Record<string, unknown>) {
  const respond = vi.fn();
  await usageHandlers["sessions.usage"]({
    respond,
    params,
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
  return respond;
}

async function runSessionsUsageTimeseries(params: Record<string, unknown>) {
  const respond = vi.fn();
  await usageHandlers["sessions.usage.timeseries"]({
    respond,
    params,
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage.timeseries"]>[0]);
  return respond;
}

async function runSessionsUsageLogs(params: Record<string, unknown>) {
  const respond = vi.fn();
  await usageHandlers["sessions.usage.logs"]({
    respond,
    params,
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage.logs"]>[0]);
  return respond;
}

const BASE_USAGE_RANGE = {
  startDate: "2026-02-01",
  endDate: "2026-02-02",
  limit: 10,
} as const;

function expectSuccessfulSessionsUsage(
  respond: ReturnType<typeof vi.fn>,
): Array<{ key: string; agentId: string }> {
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  const result = respond.mock.calls[0]?.[1] as {
    sessions: Array<{ key: string; agentId: string }>;
  };
  return result.sessions;
}

describe("sessions.usage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("discovers sessions across configured agents and keeps agentId in key", async () => {
    const respond = await runSessionsUsage(BASE_USAGE_RANGE);

    expect(vi.mocked(discoverAllSessions)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(discoverAllSessions).mock.calls[0]?.[0]?.agentId).toBe("main");
    expect(vi.mocked(discoverAllSessions).mock.calls[1]?.[0]?.agentId).toBe("opus");

    const sessions = expectSuccessfulSessionsUsage(respond);
    expect(sessions).toHaveLength(2);

    // Sorted by most recent first (mtime=200 -> opus first).
    expect(sessions[0].key).toBe("agent:opus:s-opus");
    expect(sessions[0].agentId).toBe("opus");
    expect(sessions[1].key).toBe("agent:main:s-main");
    expect(sessions[1].agentId).toBe("main");
  });

  it("aggregates transcript usage by provider and model", async () => {
    const totals = (totalTokens: number, totalCost: number) => ({
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      totalCost,
      inputCost: totalCost,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    });

    vi.mocked(loadSessionCostSummary).mockImplementation(async (opts) => {
      if (opts.sessionId === "s-main") {
        return {
          ...totals(40, 0.04),
          modelUsage: [
            {
              provider: "openai-codex",
              model: "gpt-5.4-mini",
              count: 2,
              totals: totals(40, 0.04),
            },
          ],
        } as Awaited<ReturnType<typeof loadSessionCostSummary>>;
      }
      if (opts.sessionId === "s-opus") {
        return {
          ...totals(12, 0.02),
          modelUsage: [
            {
              provider: "openrouter",
              model: "z-ai/glm-5.1",
              count: 1,
              totals: totals(12, 0.02),
            },
          ],
        } as Awaited<ReturnType<typeof loadSessionCostSummary>>;
      }
      return totals(0, 0) as Awaited<ReturnType<typeof loadSessionCostSummary>>;
    });

    const respond = await runSessionsUsage(BASE_USAGE_RANGE);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const result = respond.mock.calls[0]?.[1] as {
      totals: { totalTokens: number; totalCost: number };
      aggregates: {
        byModel: Array<{
          provider?: string;
          model?: string;
          count: number;
          totals: { totalTokens: number; totalCost: number };
        }>;
        byProvider: Array<{
          provider?: string;
          count: number;
          totals: { totalTokens: number; totalCost: number };
        }>;
      };
    };

    expect(result.totals.totalTokens).toBe(52);
    expect(result.totals.totalCost).toBeCloseTo(0.06);
    expect(result.aggregates.byModel).toEqual([
      expect.objectContaining({
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        count: 2,
        totals: expect.objectContaining({ totalTokens: 40, totalCost: 0.04 }),
      }),
      expect.objectContaining({
        provider: "openrouter",
        model: "z-ai/glm-5.1",
        count: 1,
        totals: expect.objectContaining({ totalTokens: 12, totalCost: 0.02 }),
      }),
    ]);
    expect(result.aggregates.byProvider).toEqual([
      expect.objectContaining({
        provider: "openai-codex",
        count: 2,
        totals: expect.objectContaining({ totalTokens: 40, totalCost: 0.04 }),
      }),
      expect.objectContaining({
        provider: "openrouter",
        count: 1,
        totals: expect.objectContaining({ totalTokens: 12, totalCost: 0.02 }),
      }),
    ]);
  });

  it("falls back to session-store token fields when transcript usage is empty", async () => {
    vi.mocked(loadSessionCostSummary).mockResolvedValue({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    });
    const updatedAt = Date.UTC(2026, 1, 1, 12, 0, 0);
    vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
      storePath: "(multiple)",
      store: {
        "agent:main:webchat:direct:abc": {
          sessionId: "s-main",
          updatedAt,
          inputTokens: 10,
          outputTokens: 2,
          cacheRead: 4,
          cacheWrite: 1,
          modelProvider: "openai-codex",
          model: "gpt-5.4-mini",
        },
      },
    });

    const respond = await runSessionsUsage(BASE_USAGE_RANGE);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const result = respond.mock.calls[0]?.[1] as {
      totals: { totalTokens: number; missingCostEntries: number };
      aggregates: {
        byModel: Array<{
          provider?: string;
          model?: string;
          count: number;
          totals: { totalTokens: number; missingCostEntries: number };
        }>;
      };
    };

    expect(result.totals.totalTokens).toBe(17);
    expect(result.totals.missingCostEntries).toBe(1);
    expect(result.aggregates.byModel).toEqual([
      expect.objectContaining({
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        count: 1,
        totals: expect.objectContaining({ totalTokens: 17, missingCostEntries: 1 }),
      }),
    ]);
  });

  it("includes store-only chat sessions that have recorded token usage", async () => {
    vi.mocked(loadSessionCostSummary).mockResolvedValue({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    });
    const updatedAt = Date.UTC(2026, 1, 1, 12, 0, 0);
    vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
      storePath: "(multiple)",
      store: {
        "agent:main:webchat:direct:store-only": {
          sessionId: "store-only",
          updatedAt,
          inputTokens: 7,
          outputTokens: 3,
          modelProvider: "openrouter",
          model: "z-ai/glm-5.1",
        },
      },
    });

    const respond = await runSessionsUsage(BASE_USAGE_RANGE);
    const sessions = expectSuccessfulSessionsUsage(respond);

    expect(sessions.some((session) => session.key === "agent:main:webchat:direct:store-only")).toBe(
      true,
    );
    const result = respond.mock.calls[0]?.[1] as {
      totals: { totalTokens: number };
      aggregates: {
        byProvider: Array<{
          provider?: string;
          count: number;
          totals: { totalTokens: number };
        }>;
      };
    };
    expect(result.totals.totalTokens).toBe(10);
    expect(result.aggregates.byProvider).toEqual([
      expect.objectContaining({
        provider: "openrouter",
        count: 1,
        totals: expect.objectContaining({ totalTokens: 10 }),
      }),
    ]);
  });

  it("does not treat session-store totalTokens snapshots as billing usage", async () => {
    vi.mocked(loadSessionCostSummary).mockResolvedValue({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    });
    vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
      storePath: "(multiple)",
      store: {
        "agent:main:webchat:direct:snapshot-only": {
          sessionId: "snapshot-only",
          updatedAt: Date.UTC(2026, 1, 1, 12, 0, 0),
          totalTokens: 90_000,
          modelProvider: "openrouter",
          model: "z-ai/glm-5.1",
        },
      },
    });

    const respond = await runSessionsUsage(BASE_USAGE_RANGE);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const result = respond.mock.calls[0]?.[1] as {
      sessions: Array<{ key: string }>;
      totals: { totalTokens: number };
      aggregates: { byModel: unknown[] };
    };
    expect(result.sessions.some((session) => session.key.includes("snapshot-only"))).toBe(false);
    expect(result.totals.totalTokens).toBe(0);
    expect(result.aggregates.byModel).toEqual([]);
  });

  it("includes task run-log usage as task source when no session transcript already covers it", async () => {
    vi.mocked(discoverAllSessions).mockResolvedValue([]);
    vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
      storePath: "(multiple)",
      store: {},
    });
    vi.mocked(loadCronStore).mockResolvedValue({
      version: 1,
      jobs: [{ id: "job-1", name: "Daily Report", agentId: "opus", kind: "agentTurn" }],
    } as never);
    vi.mocked(readCronRunLogEntriesPageAll).mockResolvedValue({
      entries: [
        {
          ts: Date.UTC(2026, 1, 1, 14, 0, 0),
          jobId: "job-1",
          action: "finished",
          status: "ok",
          provider: "openrouter",
          model: "z-ai/glm-5.1",
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            cache_read_tokens: 3,
            cache_write_tokens: 2,
          },
        },
      ],
      total: 1,
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    });

    const respond = await runSessionsUsage(BASE_USAGE_RANGE);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const result = respond.mock.calls[0]?.[1] as {
      sessions: Array<{
        key: string;
        source: string;
        agentId?: string;
        usage?: { totalTokens?: number };
      }>;
      totals: { totalTokens: number; missingCostEntries: number };
      aggregates: {
        bySource: Array<{ source: string; totals: { totalTokens: number } }>;
        byModel: Array<{ provider?: string; model?: string; totals: { totalTokens: number } }>;
      };
    };

    expect(result.sessions).toEqual([
      expect.objectContaining({
        key: `task:job-1:${Date.UTC(2026, 1, 1, 14, 0, 0)}`,
        source: "task",
        agentId: "opus",
        usage: expect.objectContaining({ totalTokens: 30 }),
      }),
    ]);
    expect(result.totals.totalTokens).toBe(30);
    expect(result.totals.missingCostEntries).toBe(1);
    expect(result.aggregates.bySource).toEqual([
      expect.objectContaining({
        source: "task",
        totals: expect.objectContaining({ totalTokens: 30 }),
      }),
    ]);
    expect(result.aggregates.byModel).toEqual([
      expect.objectContaining({
        provider: "openrouter",
        model: "z-ai/glm-5.1",
        totals: expect.objectContaining({ totalTokens: 30 }),
      }),
    ]);
  });

  it("resolves store entries by sessionId when queried via discovered agent-prefixed key", async () => {
    const storeKey = "agent:opus:slack:dm:u123";
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-usage-test-"));

    try {
      await withEnvAsync({ FASED_STATE_DIR: stateDir }, async () => {
        const agentSessionsDir = path.join(stateDir, "agents", "opus", "sessions");
        fs.mkdirSync(agentSessionsDir, { recursive: true });
        const sessionFile = path.join(agentSessionsDir, "s-opus.jsonl");
        fs.writeFileSync(sessionFile, "", "utf-8");

        // Swap the store mock for this test: the canonical key differs from the discovered key
        // but points at the same sessionId.
        vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
          storePath: "(multiple)",
          store: {
            [storeKey]: {
              sessionId: "s-opus",
              sessionFile: "s-opus.jsonl",
              label: "Named session",
              updatedAt: 999,
            },
          },
        });

        // Query via discovered key: agent:<id>:<sessionId>
        const respond = await runSessionsUsage({ ...BASE_USAGE_RANGE, key: "agent:opus:s-opus" });
        const sessions = expectSuccessfulSessionsUsage(respond);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.key).toBe(storeKey);
        expect(vi.mocked(loadSessionCostSummary)).toHaveBeenCalled();
        expect(
          vi.mocked(loadSessionCostSummary).mock.calls.some((call) => call[0]?.agentId === "opus"),
        ).toBe(true);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects traversal-style keys in specific session usage lookups", async () => {
    const respond = await runSessionsUsage({
      ...BASE_USAGE_RANGE,
      key: "agent:opus:../../etc/passwd",
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    const error = respond.mock.calls[0]?.[2] as { message?: string } | undefined;
    expect(error?.message).toContain("Invalid session reference");
  });

  it("passes parsed agentId into sessions.usage.timeseries", async () => {
    await runSessionsUsageTimeseries({
      key: "agent:opus:s-opus",
    });

    expect(vi.mocked(loadSessionUsageTimeSeries)).toHaveBeenCalled();
    expect(vi.mocked(loadSessionUsageTimeSeries).mock.calls[0]?.[0]?.agentId).toBe("opus");
  });

  it("passes parsed agentId into sessions.usage.logs", async () => {
    await runSessionsUsageLogs({
      key: "agent:opus:s-opus",
    });

    expect(vi.mocked(loadSessionLogs)).toHaveBeenCalled();
    expect(vi.mocked(loadSessionLogs).mock.calls[0]?.[0]?.agentId).toBe("opus");
  });

  it("rejects traversal-style keys in timeseries/log lookups", async () => {
    const timeseriesRespond = await runSessionsUsageTimeseries({
      key: "agent:opus:../../etc/passwd",
    });
    expect(timeseriesRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Invalid session key"),
      }),
    );

    const logsRespond = await runSessionsUsageLogs({
      key: "agent:opus:../../etc/passwd",
    });
    expect(logsRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Invalid session key"),
      }),
    );
  });
});
