import { describe, expect, it } from "vitest";
import { adaptDeterministicSkillResult } from "./deterministic-result-adapters.js";
import type { CronJob } from "./types.js";

function makeSkillJob(toolName: string, input: Record<string, unknown>): CronJob {
  return {
    id: "task-test",
    name: "Task test",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "test" },
    executionPolicy: {
      executionMode: "skill-only",
      skillScope: "selected",
      allowedSkills: [toolName],
      skillAction: { toolName, input },
      modelPolicy: { mode: "none" },
    },
    state: {},
  };
}

describe("deterministic result adapters", () => {
  it("formats mining status without a model summarizer", () => {
    const adapted = adaptDeterministicSkillResult({
      job: makeSkillJob("mining", { action: "status" }),
      toolName: "mining",
      outputText: "{}",
      rawResult: {
        details: {
          running: true,
          enabledWanted: true,
          activeRiskMode: "deterministic",
          nextActionDetail: "waiting for next cycle",
          activeCommitSol: "0.5 SOL",
        },
      },
    });

    expect(adapted).toMatchObject({
      adapterId: "mining:status",
      directDelivery: true,
    });
    expect(adapted?.outputText).toContain("Mining status");
    expect(adapted?.outputText).toContain("running: yes");
    expect(adapted?.outputText).toContain("risk mode: deterministic");
  });

  it("formats provider auth health without a model summarizer", () => {
    const adapted = adaptDeterministicSkillResult({
      job: makeSkillJob("gateway", { action: "models.auth.status" }),
      toolName: "gateway",
      outputText: "{}",
      rawResult: {
        details: {
          ok: true,
          result: {
            providers: [
              { provider: "openrouter", status: "ok", profiles: [{ profileId: "default" }] },
              { provider: "anthropic", status: "missing", profiles: [] },
            ],
          },
        },
      },
    });

    expect(adapted).toMatchObject({
      adapterId: "provider-health:auth",
      directDelivery: true,
    });
    expect(adapted?.outputText).toContain("Provider auth health");
    expect(adapted?.outputText).toContain("ready: 1/2");
    expect(adapted?.outputText).toContain("openrouter: ok");
  });

  it("formats offers lookup without a model summarizer", () => {
    const adapted = adaptDeterministicSkillResult({
      job: makeSkillJob("offers", { action: "search", query: "summary" }),
      toolName: "offers",
      outputText: "{}",
      rawResult: {
        details: {
          ok: true,
          offers: [{ id: "offer-1", title: "Content summary" }],
          requests: [{ id: "request-1", serviceKind: "research" }],
          orders: [],
        },
      },
    });

    expect(adapted).toMatchObject({
      adapterId: "offers:search",
      directDelivery: true,
    });
    expect(adapted?.outputText).toContain("Offers lookup");
    expect(adapted?.outputText).toContain("offers: 1");
    expect(adapted?.outputText).toContain("Content summary");
  });
});
