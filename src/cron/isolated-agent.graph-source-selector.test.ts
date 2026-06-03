import { describe, expect, it } from "vitest";
import { __testing } from "./isolated-agent/run.js";
import { SOURCE_REPAIR_NODE_IDS } from "./task-planner.js";
import type { CronJob } from "./types.js";

function makeJob(policy: CronJob["executionPolicy"] = {}): CronJob {
  return {
    id: "job-1",
    name: "source selector",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "task" },
    delivery: { mode: "none" },
    executionPolicy: policy,
    state: {},
  };
}

describe("task graph source selector", () => {
  it("uses web_fetch for explicit URL source fetches", () => {
    const action = __testing.inferGraphToolAction({
      job: makeJob(),
      nodeId: "source-fetch-web-fetch",
      message: "Summarize https://example.com/research?id=1 before analysis",
    });

    expect(action).toEqual({
      toolName: "web_fetch",
      input: {
        url: "https://example.com/research?id=1",
        extractMode: "markdown",
        maxChars: 12_000,
      },
    });
  });

  it("uses trusted source node URLs for source fetches", () => {
    const action = __testing.inferGraphToolAction({
      job: makeJob({
        planner: {
          source: "heuristic",
          strategy: "cheap-model",
          rationale: "trusted source test",
          graph: {
            version: 1,
            entryNodeId: "collect-data",
            terminalNodeIds: ["deliver"],
            nodes: [
              {
                id: "source-fetch-trusted-market-report",
                label: "Trusted source",
                kind: "tool",
                sourceUrl: "https://example.com/trusted-market-report",
              },
            ],
          },
        },
      }),
      nodeId: "source-fetch-trusted-market-report",
      message: "Analyze BTC risk",
    });

    expect(action).toEqual({
      toolName: "web_fetch",
      input: {
        url: "https://example.com/trusted-market-report",
        extractMode: "markdown",
        maxChars: 12_000,
      },
    });
  });

  it("uses gateway for provider catalog source fetches", () => {
    const action = __testing.inferGraphToolAction({
      job: makeJob(),
      nodeId: "source-fetch-gateway",
      message: "Check live provider model catalog status before analysis",
    });

    expect(action).toEqual({
      toolName: "gateway",
      input: { action: "models.catalog.status" },
    });
  });

  it("uses direct domain tools before generic web search", () => {
    expect(
      __testing.inferGraphToolAction({
        job: makeJob(),
        nodeId: "source-fetch-wallet",
        message: "Analyze wallet balance risk with live data",
      }),
    ).toEqual({
      toolName: "wallet",
      input: { action: "balance" },
    });

    expect(
      __testing.inferGraphToolAction({
        job: makeJob(),
        nodeId: "source-fetch-offers",
        message: "Analyze offers in the marketplace with live data",
      }),
    ).toEqual({
      toolName: "offers",
      input: { action: "search", query: "Analyze offers in the marketplace with live data" },
    });
  });

  it("respects selected skill allowlists while choosing a source", () => {
    const action = __testing.inferGraphToolAction({
      job: makeJob({
        skillScope: "selected",
        allowedSkills: ["gateway"],
      }),
      nodeId: "source-fetch-gateway",
      message: "Fetch https://example.com and check provider model catalog",
    });

    expect(action).toEqual({
      toolName: "gateway",
      input: { action: "models.catalog.status" },
    });

    expect(
      __testing.inferGraphToolAction({
        job: makeJob({
          skillScope: "selected",
          allowedSkills: ["gateway"],
        }),
        nodeId: "source-fetch-web-fetch",
        message: "Fetch https://example.com and check provider model catalog",
      }),
    ).toBeUndefined();
  });

  it("falls back to web_search for generic live market source fetches", () => {
    const action = __testing.inferGraphToolAction({
      job: makeJob(),
      nodeId: "source-fetch-web-search",
      message: "Analyze live BTC market risk",
    });

    expect(action).toEqual({
      toolName: "web_search",
      input: { query: "Analyze live BTC market risk", count: 5 },
    });
  });

  it("routes dynamic repair source nodes to live search", () => {
    const action = __testing.inferGraphToolAction({
      job: makeJob(),
      nodeId: SOURCE_REPAIR_NODE_IDS.web_search,
      message: "Analyze market risk after weak source quality",
    });

    expect(action).toEqual({
      toolName: "web_search",
      input: { query: "Analyze market risk after weak source quality", count: 5 },
    });
  });

  it("routes domain-specific dynamic repair source nodes to their tools", () => {
    expect(
      __testing.inferGraphToolAction({
        job: makeJob(),
        nodeId: SOURCE_REPAIR_NODE_IDS.web_fetch,
        message: "Refetch https://example.com/report after weak source quality",
      }),
    ).toEqual({
      toolName: "web_fetch",
      input: {
        url: "https://example.com/report",
        extractMode: "markdown",
        maxChars: 12_000,
      },
    });

    expect(
      __testing.inferGraphToolAction({
        job: makeJob(),
        nodeId: SOURCE_REPAIR_NODE_IDS.gateway,
        message: "Check provider model catalog after weak source quality",
      }),
    ).toEqual({
      toolName: "gateway",
      input: { action: "models.catalog.status" },
    });

    expect(
      __testing.inferGraphToolAction({
        job: makeJob(),
        nodeId: SOURCE_REPAIR_NODE_IDS.wallet,
        message: "Check wallet balance after weak source quality",
      }),
    ).toEqual({
      toolName: "wallet",
      input: { action: "balance" },
    });

    expect(
      __testing.inferGraphToolAction({
        job: makeJob(),
        nodeId: SOURCE_REPAIR_NODE_IDS.mining,
        message: "Check mining status after weak source quality",
      }),
    ).toEqual({
      toolName: "mining",
      input: { action: "status" },
    });

    expect(
      __testing.inferGraphToolAction({
        job: makeJob(),
        nodeId: SOURCE_REPAIR_NODE_IDS.offers,
        message: "Check offers in the marketplace after weak source quality",
      }),
    ).toEqual({
      toolName: "offers",
      input: {
        action: "search",
        query: "Check offers in the marketplace after weak source quality",
      },
    });
  });

  it("detects every source handler requested by a mixed-source task", () => {
    expect(
      __testing.sourceFetchToolCandidates(
        "Fetch https://example.com and check provider catalog, wallet balance, offers, and live market news",
      ),
    ).toEqual(["web_fetch", "gateway", "wallet", "offers", "web_search"]);
  });
});
