import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CRON_FORM } from "../app-defaults.ts";
import type { CronJob } from "../types.ts";
import { renderCron, type CronProps } from "./cron.ts";

function createJob(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: "Daily ping",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "ping" },
    ...overrides,
  };
}

function createProps(overrides: Partial<CronProps> = {}): CronProps {
  return {
    basePath: "",
    loading: false,
    jobsLoadingMore: false,
    status: null,
    jobs: [],
    jobsTotal: 0,
    jobsHasMore: false,
    jobsQuery: "",
    jobsEnabledFilter: "all",
    jobsScheduleKindFilter: "all",
    jobsLastStatusFilter: "all",
    jobsAdaptiveRouteFilter: "all",
    jobsSortBy: "nextRunAtMs",
    jobsSortDir: "asc",
    error: null,
    busy: false,
    form: { ...DEFAULT_CRON_FORM },
    fieldErrors: {},
    canSubmit: true,
    editingJobId: null,
    channels: [],
    channelLabels: {},
    runsJobId: null,
    runs: [],
    runsTotal: 0,
    runsHasMore: false,
    runsLoadingMore: false,
    runsScope: "all",
    runsStatuses: [],
    runsDeliveryStatuses: [],
    runsStatusFilter: "all",
    runsQuery: "",
    runsSortDir: "desc",
    agentSuggestions: [],
    modelSuggestions: [],
    thinkingSuggestions: [],
    timezoneSuggestions: [],
    deliveryToSuggestions: [],
    accountSuggestions: [],
    onFormChange: () => undefined,
    onRefresh: () => undefined,
    onCreate: () => undefined,
    onAdd: () => undefined,
    onEdit: () => undefined,
    onClone: () => undefined,
    onCancelEdit: () => undefined,
    onToggle: () => undefined,
    onRun: () => undefined,
    onRemove: () => undefined,
    onLoadRuns: () => undefined,
    onLoadMoreJobs: () => undefined,
    onJobsFiltersChange: () => undefined,
    onJobsFiltersReset: () => undefined,
    onLoadMoreRuns: () => undefined,
    onRunsFiltersChange: () => undefined,
    ...overrides,
  };
}

describe("cron compact authoring", () => {
  it("keeps authoring in the shared modal path while preserving compact filters and delivery details", () => {
    const container = document.createElement("div");
    const disabledJob = createJob("job-disabled", {
      name: "Paused digest",
      enabled: false,
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "summarize delivery" },
      delivery: { mode: "announce", channel: "telegram", to: "ops" },
      state: { lastStatus: "skipped" },
    });
    render(
      renderCron(
        createProps({
          jobs: [disabledJob],
          jobsTotal: 1,
          jobsQuery: "digest",
          jobsEnabledFilter: "disabled",
          jobsSortBy: "updatedAtMs",
          jobsSortDir: "desc",
        }),
      ),
      container,
    );

    expect(container.querySelector("details.cron-workspace-form")).toBeNull();
    const search = container.querySelector(".cron-filter-search input");
    expect(search).toBeInstanceOf(HTMLInputElement);
    expect((search as HTMLInputElement).value).toBe("digest");
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="Task status"]')?.value,
    ).toBe("disabled");
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="Task date sort"]')?.value,
    ).toBe("desc");
    expect(container.textContent).not.toContain("Task activity");

    const jobRow = container.querySelector(".cron-job");
    expect(jobRow?.textContent).toContain("Paused digest");
    expect(jobRow?.querySelector(".task-status-dot--muted")).not.toBeNull();
    expect(jobRow?.textContent).toContain("announce");
    expect(jobRow?.textContent).toContain("telegram -> ops");
    expect(container.textContent).not.toMatch(/cron\.[A-Za-z0-9_.]+/);
  });

  it("routes create and edit through the shared task modal callbacks", () => {
    const container = document.createElement("div");
    const onCreate = vi.fn();
    const onEdit = vi.fn();
    const job = createJob("job-edit", { name: "Edit digest" });
    render(
      renderCron(
        createProps({
          jobs: [job],
          onCreate,
          onEdit,
        }),
      ),
      container,
    );

    const create = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Create task",
    );
    expect(create).not.toBeUndefined();
    create?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onCreate).toHaveBeenCalledTimes(1);

    const edit = container.querySelector('button[aria-label="Edit task"]');
    expect(edit).not.toBeNull();
    edit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onEdit).toHaveBeenCalledWith(job);
  });
});
