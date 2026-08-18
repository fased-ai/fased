import { describe, expect, it, vi } from "vitest";
import { createGatewayAgentExecutionFacade } from "./agent-execution-facade.js";

describe("Gateway agent execution facade", () => {
  it("loads current configuration and fixes hook execution to the cron lane", async () => {
    const config = { gateway: { port: 18789 } };
    const result = { status: "ok", summary: "done" };
    const loadConfig = vi.fn(() => config);
    const runIsolatedAgentTurn = vi.fn(async () => result);
    const facade = createGatewayAgentExecutionFacade({
      loadConfig: loadConfig as never,
      runIsolatedAgentTurn: runIsolatedAgentTurn as never,
    });
    const deps = { marker: "deps" };
    const job = { id: "hook-job" };

    await expect(
      facade.runHookAgent({
        deps: deps as never,
        job: job as never,
        message: "run this",
        sessionKey: "agent:main:main",
      }),
    ).resolves.toBe(result);

    expect(loadConfig).toHaveBeenCalledOnce();
    expect(runIsolatedAgentTurn).toHaveBeenCalledWith({
      cfg: config,
      deps,
      job,
      message: "run this",
      sessionKey: "agent:main:main",
      lane: "cron",
    });
  });
});
