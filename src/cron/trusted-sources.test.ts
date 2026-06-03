import { describe, expect, it } from "vitest";
import { matchingTrustedSourcesForTask, recordTrustedSourceOutcome } from "./trusted-sources.js";
import type { CronStoreFile, CronTaskTrustedSource } from "./types.js";

function trustedSource(
  id: string,
  source: string,
  overrides: Partial<CronTaskTrustedSource> = {},
): CronTaskTrustedSource {
  return {
    id,
    source,
    kind: "url",
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    lastUsedAtMs: 1_000,
    useCount: 1,
    agentId: "main",
    sessionKey: "session-a",
    taskType: "market",
    active: true,
    ...overrides,
  };
}

describe("trusted task sources", () => {
  it("records run outcomes for trusted source memory", () => {
    const store: CronStoreFile = {
      version: 1,
      jobs: [],
      trustedSources: [trustedSource("trusted-good", "https://example.com/report")],
    };

    const updated = recordTrustedSourceOutcome(store, {
      trustedSourceId: "trusted-good",
      nowMs: 2_000,
      status: "ok",
      qualityScore: 0.92,
      qualityBand: "high",
    });

    expect(updated).toMatchObject({
      id: "trusted-good",
      lastRunAtMs: 2_000,
      lastOutcome: "ok",
      lastQualityScore: 0.92,
      lastQualityBand: "high",
      successCount: 1,
      failureCount: 0,
      useCount: 2,
    });
  });

  it("prefers successful trusted sources over repeatedly failed ones", () => {
    const store: CronStoreFile = {
      version: 1,
      jobs: [],
      trustedSources: [
        trustedSource("trusted-bad", "https://bad.example.com/report", {
          successCount: 0,
          failureCount: 4,
          lastOutcome: "blocked",
          lastQualityBand: "unavailable",
          lastQualityScore: 0,
          lastRunAtMs: 5_000,
        }),
        trustedSource("trusted-good", "https://good.example.com/report", {
          successCount: 2,
          failureCount: 0,
          lastOutcome: "ok",
          lastQualityBand: "high",
          lastQualityScore: 0.86,
          lastRunAtMs: 4_000,
        }),
      ],
    };

    const matches = matchingTrustedSourcesForTask({
      store,
      agentId: "main",
      sessionKey: "session-a",
      text: "Check BTC market risk",
    });

    expect(matches.map((entry) => entry.id)).toEqual(["trusted-good"]);
  });
});
