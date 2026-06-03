import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.ts";
import { getVisibleCronJobs } from "./cron.ts";

function job(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: `Job ${id}`,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "test" },
    ...overrides,
  };
}

describe("getVisibleCronJobs", () => {
  it("returns all jobs when no client-side filters are active", () => {
    const jobs = [job("a"), job("b", { schedule: { kind: "cron", expr: "0 9 * * *" } })];
    const visible = getVisibleCronJobs({
      cronJobs: jobs,
      cronJobsQuery: "",
      cronJobsEnabledFilter: "all",
      cronJobsScheduleKindFilter: "all",
      cronJobsLastStatusFilter: "all",
      cronJobsAdaptiveRouteFilter: "all",
    });
    expect(visible).toHaveLength(2);
  });

  it("filters by schedule kind", () => {
    const jobs = [
      job("a", { schedule: { kind: "at", at: "2026-03-01T08:00:00Z" } }),
      job("b", { schedule: { kind: "every", everyMs: 60_000 } }),
      job("c", { schedule: { kind: "cron", expr: "0 9 * * *" } }),
    ];
    const visible = getVisibleCronJobs({
      cronJobs: jobs,
      cronJobsQuery: "",
      cronJobsEnabledFilter: "all",
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "all",
      cronJobsAdaptiveRouteFilter: "all",
    });
    expect(visible.map((entry) => entry.id)).toEqual(["c"]);
  });

  it("filters by last status", () => {
    const jobs = [
      job("ok", { state: { lastStatus: "ok", lastRunAtMs: 1 } }),
      job("error", { state: { lastStatus: "error", lastRunAtMs: 2 } }),
      job("unknown"),
    ];
    const visible = getVisibleCronJobs({
      cronJobs: jobs,
      cronJobsQuery: "",
      cronJobsEnabledFilter: "all",
      cronJobsScheduleKindFilter: "all",
      cronJobsLastStatusFilter: "error",
      cronJobsAdaptiveRouteFilter: "all",
    });
    expect(visible.map((entry) => entry.id)).toEqual(["error"]);
  });

  it("combines schedule and last-status filters", () => {
    const jobs = [
      job("a", {
        schedule: { kind: "cron", expr: "0 9 * * *" },
        state: { lastStatus: "ok", lastRunAtMs: 1 },
      }),
      job("b", {
        schedule: { kind: "cron", expr: "0 10 * * *" },
        state: { lastStatus: "error", lastRunAtMs: 2 },
      }),
      job("c", {
        schedule: { kind: "every", everyMs: 60_000 },
        state: { lastStatus: "error", lastRunAtMs: 3 },
      }),
    ];
    const visible = getVisibleCronJobs({
      cronJobs: jobs,
      cronJobsQuery: "",
      cronJobsEnabledFilter: "all",
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "error",
      cronJobsAdaptiveRouteFilter: "all",
    });
    expect(visible.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("filters by adaptive next route", () => {
    const jobs = [
      job("skill", {
        state: {
          adaptiveRouting: {
            lastDecision: {
              source: "history",
              route: "skill-only",
              reason: "stable direct tool result",
              sampleSize: 3,
              taskType: "smoke",
              createdAtMs: 1,
            },
          },
        },
      }),
      job("model", {
        state: {
          adaptiveRouting: {
            lastDecision: {
              source: "history",
              route: "strong-model",
              reason: "cheap checks escalated",
              sampleSize: 3,
              taskType: "smoke",
              createdAtMs: 1,
            },
          },
        },
      }),
      job("unknown"),
    ];
    const visible = getVisibleCronJobs({
      cronJobs: jobs,
      cronJobsQuery: "",
      cronJobsEnabledFilter: "all",
      cronJobsScheduleKindFilter: "all",
      cronJobsLastStatusFilter: "all",
      cronJobsAdaptiveRouteFilter: "skill-only",
    });
    expect(visible.map((entry) => entry.id)).toEqual(["skill"]);
  });

  it("filters by enabled state and search text", () => {
    const jobs = [
      job("enabled-wallet", { name: "Wallet check", enabled: true }),
      job("disabled-wallet", { name: "Wallet disabled", enabled: false }),
      job("enabled-market", { name: "Market watch", enabled: true }),
    ];
    const visible = getVisibleCronJobs({
      cronJobs: jobs,
      cronJobsQuery: "wallet",
      cronJobsEnabledFilter: "enabled",
      cronJobsScheduleKindFilter: "all",
      cronJobsLastStatusFilter: "all",
      cronJobsAdaptiveRouteFilter: "all",
    });
    expect(visible.map((entry) => entry.id)).toEqual(["enabled-wallet"]);
  });
});
