import "./isolated-agent.mocks.js";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import * as modelFallback from "../agents/model-fallback.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import { makeCfg, makeJob, withTempCronHome } from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

beforeEach(() => {
  setupIsolatedAgentTurnMocks({ fast: true });
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
    payloads: [{ text: "done" }],
    meta: { durationMs: 1 },
  });
});

it("rejects an unavailable task payload model before any inference instead of using defaults", async () => {
  await withTempCronHome(async (home) => {
    const cfg = makeCfg(home, path.join(home, "sessions.json"), {
      agents: {
        defaults: {
          workspace: path.join(home, "workspace"),
          model: "anthropic/claude-opus-4-5",
          models: { "anthropic/claude-opus-4-5": {} },
        },
      },
    });
    const result = await runCronIsolatedAgentTurn({
      cfg,
      deps: {
        sendMessageSlack: vi.fn(),
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageIMessage: vi.fn(),
      },
      job: makeJob({
        kind: "agentTurn",
        message: "Check WEN read-only",
        model: "openai/model-not-approved",
      }),
      message: "Check WEN read-only",
      sessionKey: "cron:job-1",
    });
    expect(result.status).toBe("error");
    expect(result.error).toBe("model not allowed: openai/model-not-approved");
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });
});

it("passes a bounded transient cooldown probe from task fallback to execution", async () => {
  const spy = vi
    .spyOn(modelFallback, "runWithModelFallback")
    .mockImplementationOnce(async ({ run }) => ({
      result: await run("anthropic", "claude-opus-4-5", { allowTransientCooldownProbe: true }),
      provider: "anthropic",
      model: "claude-opus-4-5",
      attempts: [],
    }));
  try {
    await withTempCronHome(async (home) => {
      const cfg = makeCfg(home, path.join(home, "sessions.json"));
      await runCronIsolatedAgentTurn({
        cfg,
        deps: {
          sendMessageSlack: vi.fn(),
          sendMessageWhatsApp: vi.fn(),
          sendMessageTelegram: vi.fn(),
          sendMessageDiscord: vi.fn(),
          sendMessageIMessage: vi.fn(),
        },
        job: makeJob({ kind: "agentTurn", message: "Check WEN read-only" }),
        message: "Check WEN read-only",
        sessionKey: "cron:job-1",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
        expect.objectContaining({ allowTransientCooldownProbe: true }),
      );
    });
  } finally {
    spy.mockRestore();
  }
});
