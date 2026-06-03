import { describe, expect, it, vi } from "vitest";
import { loadDreamingStatus, updateDreamingEnabled, type DreamingState } from "./dreaming.ts";

function createState(): { state: DreamingState; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  const state: DreamingState = {
    client: {
      request,
    } as unknown as DreamingState["client"],
    connected: true,
    configSnapshot: { hash: "hash-1" },
    applySessionKey: "main",
    dreamingStatusLoading: false,
    dreamingStatusError: null,
    dreamingStatus: null,
    dreamingModeSaving: false,
    dreamDiaryLoading: false,
    dreamDiaryError: null,
    dreamDiaryPath: null,
    dreamDiaryContent: null,
    lastError: null,
  };
  return { state, request };
}

describe("dreaming controller", () => {
  it("loads and normalizes dreaming status from doctor.memory.status", async () => {
    const { state, request } = createState();
    state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "test",
      agents: [
        { id: "main", name: "Assistant" },
        { id: "research", name: "Research" },
      ],
    };
    state.agentsSelectedId = "research";
    request.mockResolvedValue({
      dreaming: {
        enabled: true,
        timezone: "America/Los_Angeles",
        verboseLogging: false,
        storageMode: "inline",
        separateReports: false,
        shortTermCount: 8,
        recallSignalCount: 14,
        dailySignalCount: 6,
        totalSignalCount: 20,
        phaseSignalCount: 11,
        lightPhaseHitCount: 7,
        remPhaseHitCount: 4,
        promotedTotal: 21,
        promotedToday: 2,
        phases: {
          light: {
            enabled: true,
            cron: "0 */6 * * *",
            lookbackDays: 2,
            limit: 100,
            managedCronPresent: true,
            nextRunAtMs: 12345,
          },
          deep: {
            enabled: true,
            cron: "0 3 * * *",
            limit: 10,
            minScore: 0.8,
            minRecallCount: 3,
            minUniqueQueries: 3,
            recencyHalfLifeDays: 14,
            maxAgeDays: 30,
            managedCronPresent: true,
            nextRunAtMs: 23456,
          },
          rem: {
            enabled: true,
            cron: "0 5 * * 0",
            lookbackDays: 7,
            limit: 10,
            minPatternStrength: 0.75,
            managedCronPresent: true,
            nextRunAtMs: 34567,
          },
        },
      },
    });

    await loadDreamingStatus(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "research" });
    expect(state.dreamingStatus).toEqual(
      expect.objectContaining({
        enabled: true,
        shortTermCount: 8,
        totalSignalCount: 20,
        phaseSignalCount: 11,
        promotedToday: 2,
        phases: expect.objectContaining({
          deep: expect.objectContaining({
            minScore: 0.8,
            nextRunAtMs: 23456,
          }),
        }),
      }),
    );
    expect(state.dreamingStatusLoading).toBe(false);
    expect(state.dreamingStatusError).toBeNull();
  });

  it("patches config to update global dreaming enablement", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({ ok: true });

    const ok = await updateDreamingEnabled(state, false);

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "config.patch",
      expect.objectContaining({
        baseHash: "hash-1",
        sessionKey: "main",
      }),
    );
    expect(state.dreamingModeSaving).toBe(false);
    expect(state.dreamingStatusError).toBeNull();
  });

  it("fails gracefully when config hash is missing", async () => {
    const { state, request } = createState();
    state.configSnapshot = {};

    const ok = await updateDreamingEnabled(state, true);

    expect(ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(state.dreamingStatusError).toContain("Config hash missing");
  });

  it("does not expose a Dream Diary read helper for the closed Memory Doctor RPC", async () => {
    const module = await import("./dreaming.ts");

    expect("loadDreamDiary" in module).toBe(false);
  });
});
