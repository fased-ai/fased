import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CRON_FORM } from "../app-defaults.ts";
import {
  addCronJob,
  loadCronModelSuggestions,
  type CronModelSuggestionsState,
  type CronState,
} from "./cron.ts";

type TestCronState = CronState & CronModelSuggestionsState;

function createState(overrides: Partial<TestCronState> = {}): TestCronState {
  return {
    client: null,
    connected: true,
    cronLoading: false,
    cronJobsLoadingMore: false,
    cronJobs: [],
    cronJobsTotal: 0,
    cronJobsHasMore: false,
    cronJobsNextOffset: null,
    cronJobsLimit: 50,
    cronJobsQuery: "",
    cronJobsEnabledFilter: "all",
    cronJobsScheduleKindFilter: "all",
    cronJobsLastStatusFilter: "all",
    cronJobsAdaptiveRouteFilter: "all",
    cronJobsSortBy: "nextRunAtMs",
    cronJobsSortDir: "asc",
    cronStatus: null,
    cronError: null,
    cronForm: { ...DEFAULT_CRON_FORM },
    cronFieldErrors: {},
    cronEditingJobId: null,
    cronRunsJobId: null,
    cronRunsLoadingMore: false,
    cronRuns: [],
    cronRunsTotal: 0,
    cronRunsHasMore: false,
    cronRunsNextOffset: null,
    cronRunsLimit: 50,
    cronRunsScope: "all",
    cronRunsStatuses: [],
    cronRunsDeliveryStatuses: [],
    cronRunsStatusFilter: "all",
    cronRunsQuery: "",
    cronRunsSortDir: "desc",
    cronRunDetail: null,
    cronRunDetailLoading: false,
    cronRunDetailError: null,
    cronBusy: false,
    cronModelSuggestions: [],
    ...overrides,
  };
}

describe("cron controller task creation", () => {
  it("loads task suggestions from the shared authenticated model payload", async () => {
    const request = vi.fn(async () => ({
      models: [
        { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
        { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
      ],
    }));
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronModelSuggestions: [],
      sessionKey: "agent:main:main",
    });

    await loadCronModelSuggestions(state);

    expect(request).toHaveBeenCalledWith("models.list", {
      includeMetadata: true,
      available: true,
      sessionKey: "agent:main:main",
    });
    expect(state.cronModelSuggestions).toEqual([
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.6-sol",
    ]);
  });

  it("creates a selected-Agent Task through cron.add and refreshes the saved row", async () => {
    const savedJob = {
      id: "agent-main-task",
      agentId: "main",
      name: "Mining strategy review",
      enabled: true,
      schedule: { kind: "every", everyMs: 1_800_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "Review mining strategy." },
      state: {},
    };
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return savedJob;
      }
      if (method === "cron.list") {
        return { jobs: [savedJob], total: 1, hasMore: false, nextOffset: null };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "Mining strategy review",
        agentId: "main",
        scheduleKind: "every",
        everyAmount: "30",
        everyUnit: "minutes",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payloadKind: "agentTurn",
        payloadText: "Review mining strategy.",
        deliveryMode: "none",
      },
    });

    await addCronJob(state);

    const addCall = request.mock.calls.find(([method]) => method === "cron.add");
    expect(addCall?.[1]).toMatchObject({
      agentId: "main",
      name: "Mining strategy review",
      schedule: { kind: "every", everyMs: 1_800_000 },
      payload: { kind: "agentTurn", message: "Review mining strategy." },
    });
    expect(request.mock.calls.map(([method]) => method)).toContain("cron.list");
    expect(request.mock.calls.map(([method]) => method)).toContain("cron.status");
    expect(state.cronJobs).toEqual([savedJob]);
  });
});
