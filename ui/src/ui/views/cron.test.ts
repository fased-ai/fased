import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CRON_FORM } from "../app-defaults.ts";
import type { CronJob, CronTaskRunDetail } from "../types.ts";
import { renderCron, renderCronRunDetailModal, type CronProps } from "./cron.ts";

function createJob(id: string): CronJob {
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
  };
}

function runDetailJob(job: CronJob): NonNullable<CronTaskRunDetail["job"]> {
  return job as unknown as NonNullable<CronTaskRunDetail["job"]>;
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
    agentOptions: [],
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

describe("cron view", () => {
  it("shows compact global task controls without a permanent activity panel", () => {
    const container = document.createElement("div");
    render(renderCron(createProps()), container);

    expect(container.textContent).toContain("0 tasks");
    expect(container.textContent).not.toContain("next n/a");
    expect(container.textContent).toContain("Create task");
    expect(container.querySelector('input[aria-label="Search tasks"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="Task status"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="Task date sort"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Latest task runs across all tasks.");
    expect(container.querySelector(".cron-summary-strip")).toBeNull();
  });

  it("renders global task runtime config controls when config handlers are provided", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();
    const onConfigRemove = vi.fn();
    const onConfigSave = vi.fn();
    const onConfigReload = vi.fn();
    render(
      renderCron(
        createProps({
          configForm: {
            cron: {
              enabled: true,
              maxConcurrentRuns: 3,
              sessionRetention: "48h",
              runLog: { maxBytes: 1000, keepLines: 50 },
            },
          },
          configDirty: true,
          onConfigPatch,
          onConfigRemove,
          onConfigSave,
          onConfigReload,
        }),
      ),
      container,
    );

    expect(container.querySelector('[data-test-id="task-runtime-config"]')).not.toBeNull();
    expect(container.textContent).toContain("Runtime & Retention");

    const scheduler = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Task scheduler"]',
    );
    expect(scheduler?.value).toBe("enabled");
    scheduler!.value = "disabled";
    scheduler!.dispatchEvent(new Event("change"));
    expect(onConfigPatch).toHaveBeenCalledWith(["cron", "enabled"], false);

    const maxRuns = container.querySelector<HTMLInputElement>(
      'input[aria-label="Max concurrent task runs"]',
    );
    expect(maxRuns?.value).toBe("3");
    maxRuns!.value = "7";
    maxRuns!.dispatchEvent(new Event("change"));
    expect(onConfigPatch).toHaveBeenCalledWith(["cron", "maxConcurrentRuns"], 7);

    const retention = container.querySelector<HTMLInputElement>(
      'input[aria-label="Task run session retention"]',
    );
    expect(retention?.value).toBe("48h");
    retention!.value = "false";
    retention!.dispatchEvent(new Event("change"));
    expect(onConfigPatch).toHaveBeenCalledWith(["cron", "sessionRetention"], false);

    const runLogBytes = container.querySelector<HTMLInputElement>(
      'input[aria-label="Task run log max bytes"]',
    );
    expect(runLogBytes?.value).toBe("1000");
    runLogBytes!.value = "";
    runLogBytes!.dispatchEvent(new Event("change"));
    expect(onConfigRemove).toHaveBeenCalledWith(["cron", "runLog", "maxBytes"]);

    container.querySelector<HTMLButtonElement>("button")?.click();
    expect(onConfigReload).toHaveBeenCalled();
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Save runtime"))
      ?.click();
    expect(onConfigSave).toHaveBeenCalled();
  });

  it("does not replace compact rows with run-history selection behavior", () => {
    const container = document.createElement("div");
    const onLoadRuns = vi.fn();
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          jobs: [job],
          onLoadRuns,
        }),
      ),
      container,
    );

    const row = container.querySelector(".list-item-clickable");
    expect(row).not.toBeNull();
    row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onLoadRuns).not.toHaveBeenCalled();
    expect(container.textContent).toContain("job-1");
    expect(container.textContent).not.toContain("History");
  });

  it("shows adaptive next routing in task rows and expanded details", () => {
    const container = document.createElement("div");
    const job: CronJob = {
      ...createJob("job-adaptive"),
      state: {
        adaptiveRouting: {
          lastDecision: {
            source: "history",
            route: "skill-only",
            reason: "Recent direct tool runs were stable.",
            taskType: "digest",
            sampleSize: 4,
            createdAtMs: 1,
          },
        },
      },
    };

    render(renderCron(createProps({ jobs: [job] })), container);

    const text = container.textContent ?? "";
    expect(text).toContain("skill-only");
    expect(text).toContain("Adaptive next");
    expect(text).toContain("4 samples");
  });

  it("filters task rows by adaptive next route", () => {
    const container = document.createElement("div");
    const skillJob: CronJob = {
      ...createJob("job-skill"),
      name: "Skill task",
      state: {
        adaptiveRouting: {
          lastDecision: {
            source: "history",
            route: "skill-only",
            reason: "Stable direct tool route.",
            taskType: "digest",
            sampleSize: 3,
            createdAtMs: 1,
          },
        },
      },
    };
    const modelJob: CronJob = {
      ...createJob("job-model"),
      name: "Model task",
      state: {
        adaptiveRouting: {
          lastDecision: {
            source: "history",
            route: "strong-model",
            reason: "Cheap checks escalated.",
            taskType: "digest",
            sampleSize: 3,
            createdAtMs: 1,
          },
        },
      },
    };

    render(
      renderCron(
        createProps({
          jobs: [skillJob, modelJob],
          jobsAdaptiveRouteFilter: "skill-only",
        }),
      ),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Skill task");
    expect(text).not.toContain("Model task");
  });

  it("shows Agent targets in expanded job rows", () => {
    const container = document.createElement("div");
    const researchJob = { ...createJob("job-research"), agentId: "research" };
    const defaultJob = { ...createJob("job-default"), agentId: undefined };

    render(
      renderCron(
        createProps({
          jobs: [researchJob, defaultJob],
          form: { ...DEFAULT_CRON_FORM, agentId: "support" },
          agentOptions: [
            { id: "main", name: "Main" },
            { id: "support", name: "Support" },
            { id: "research", name: "Research" },
          ],
        }),
      ),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Agent");
    expect(text).toContain("Research (research)");
    expect(text).toContain("Assistant");
  });

  it("shows multi-Agent coordination policy in expanded task rows", () => {
    const container = document.createElement("div");
    const job: CronJob = {
      ...createJob("job-coordination"),
      executionPolicy: {
        executionMode: "agent-turn",
        coordination: {
          mode: "consult",
          agents: ["research", "support"],
          maxAgents: 2,
          requireApproval: true,
        },
      },
    };

    render(renderCron(createProps({ jobs: [job] })), container);

    const text = container.textContent ?? "";
    expect(text).toContain("Coordination");
    expect(text).toContain("consult · research, support · max 2 · approval required");
  });

  it("offers coordination approval from expanded task rows", () => {
    const container = document.createElement("div");
    const onApproveCoordination = vi.fn();
    const job: CronJob = {
      ...createJob("job-coordination-approval"),
      executionPolicy: {
        executionMode: "agent-turn",
        coordination: {
          mode: "consult",
          agents: ["research"],
          requireApproval: true,
        },
      },
      state: {},
    };

    render(renderCron(createProps({ jobs: [job], onApproveCoordination })), container);

    expect(container.textContent).toContain("Coordination approval");
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("Approve coordination"),
    );
    expect(button).toBeTruthy();
    button?.click();
    expect(onApproveCoordination).toHaveBeenCalledWith(job);
  });

  it("shows trusted source controls in expanded task rows", () => {
    const container = document.createElement("div");
    const onSourceToggle = vi.fn();
    const onSourceRemove = vi.fn();
    const job: CronJob = {
      ...createJob("job-source"),
      executionPolicy: {
        trustedSources: [
          {
            id: "trusted-market",
            source: "https://example.com/market",
            kind: "url",
            createdAtMs: 1,
            active: true,
            lastQualityScore: 0.92,
            lastQualityBand: "high",
            successCount: 3,
            failureCount: 1,
            useCount: 4,
          },
        ],
        planner: {
          source: "heuristic",
          strategy: "cheap-model",
          rationale: "test",
          graph: {
            version: 1,
            nodes: [
              {
                id: "source-fetch-trusted-market",
                trustedSourceId: "trusted-market",
                sourceRole: "primary",
                sourceUrl: "https://example.com/market",
              },
            ],
          },
        },
      },
    };

    render(renderCron(createProps({ jobs: [job], onSourceToggle, onSourceRemove })), container);

    expect(container.textContent).toContain("Trusted sources");
    expect(container.textContent).toContain("https://example.com/market");
    expect(container.textContent).toContain("quality high 0.92");
    expect(container.textContent).toContain("primary");

    const disableButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Disable source",
    );
    disableButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSourceToggle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "trusted-market" }),
      false,
    );

    const removeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Forget source",
    );
    removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSourceRemove).toHaveBeenCalledWith(expect.objectContaining({ id: "trusted-market" }));
  });

  it("renders source repair controls and sends trusted source recovery", async () => {
    const container = document.createElement("div");
    const onRepair = vi.fn();
    const onNavigate = vi.fn();
    const job: CronJob = {
      ...createJob("job-1"),
      state: {
        lastGraphRepairStop: {
          code: "needs_user_source",
          reason: "Need a trusted source before retrying.",
          sourceNodeId: "source-fetch-web-search",
          atMs: 1_000,
        },
      },
    };

    render(renderCron(createProps({ jobs: [job], jobsTotal: 1, onRepair, onNavigate })), container);

    const input = container.querySelector<HTMLInputElement>("[data-task-trusted-source]");
    expect(container.textContent).toContain("Source recovery");
    expect(container.textContent).toContain("Add trusted source");
    expect(input).not.toBeNull();
    if (!input) {
      return;
    }
    input.value = "https://example.com/report";
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("Add trusted source"),
    );
    button?.click();

    expect(onRepair).toHaveBeenCalledWith(job, "add_trusted_source", {
      source: "https://example.com/report",
    });

    const configureButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent?.includes("Configure source"));
    configureButton?.click();
    await Promise.resolve();
    expect(onRepair).toHaveBeenCalledWith(job, "configure_source");
    expect(onNavigate).toHaveBeenCalledWith("services");
  });

  it("does not keep legacy selected row or History button state", () => {
    const container = document.createElement("div");
    const onLoadRuns = vi.fn();
    const job = createJob("job-1");
    render(
      renderCron(
        createProps({
          jobs: [job],
          runsJobId: "job-1",
          runsScope: "job",
          onLoadRuns,
        }),
      ),
      container,
    );

    const selected = container.querySelector(".list-item-selected");
    expect(selected).toBeNull();

    const historyButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "History",
    );
    expect(historyButton).toBeUndefined();
    expect(onLoadRuns).not.toHaveBeenCalled();
  });

  it("opens the latest run detail through the single row open action", () => {
    const container = document.createElement("div");
    const onRunDetail = vi.fn();
    const job = {
      ...createJob("job-1"),
      state: {
        lastRunCheckpoint: { runId: "run-abc" },
        lastRunSessionKey: "agent:main:cron:job-1:run:abc",
      },
    } satisfies CronJob;
    render(
      renderCron(
        createProps({
          jobs: [job],
          onRunDetail,
        }),
      ),
      container,
    );

    const openButton = container.querySelector('button[aria-label="Open latest run"]');
    expect(openButton).not.toBeNull();
    openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRunDetail).toHaveBeenCalledWith("run-abc");
  });

  it("opens repair checkpoint detail before stale worker leases", () => {
    const container = document.createElement("div");
    const onRunDetail = vi.fn();
    const job = {
      ...createJob("job-repair"),
      state: {
        lastRunStatus: "blocked",
        stopReason: "needsSources:needs_user_source",
        lastGraphRepairStop: {
          code: "needs_user_source",
          reason: "Needs a trusted source.",
          sourceNodeId: "source-fetch-web-search",
          atMs: 1,
        },
        lastRunCheckpoint: { runId: "run-repair" },
      },
    } satisfies CronJob;
    render(
      renderCron(
        createProps({
          jobs: [job],
          status: {
            enabled: true,
            jobs: 1,
            nextWakeAtMs: null,
            queue: {
              path: "/tmp/queue.json",
              total: 1,
              queued: 0,
              running: 1,
              terminal: 0,
              cancelRequested: 0,
              expiredLeases: 0,
              workers: [],
              activeRuns: [
                {
                  runId: "run-stale-worker",
                  jobId: "job-repair",
                  jobName: "Repair task",
                  status: "running",
                  stepId: "collect",
                  attempt: 1,
                  maxAttempts: 3,
                  leaseOwner: "local-worker",
                  leaseExpired: true,
                  queuedAtMs: 1,
                  updatedAtMs: 2,
                },
              ],
              recentRuns: [],
            },
          },
          onRunDetail,
        }),
      ),
      container,
    );

    container.querySelector<HTMLButtonElement>('button[aria-label="Open latest run"]')?.click();
    expect(onRunDetail).toHaveBeenCalledWith("run-repair");
  });

  it("shows queue control buttons for active and failed runs", () => {
    const container = document.createElement("div");
    const onQueueControl = vi.fn();
    render(
      renderCron(
        createProps({
          jobs: [createJob("job-active"), createJob("job-failed")],
          status: {
            enabled: true,
            jobs: 2,
            nextWakeAtMs: null,
            queue: {
              path: "/tmp/queue.json",
              total: 2,
              queued: 0,
              running: 1,
              terminal: 1,
              cancelRequested: 0,
              expiredLeases: 1,
              workers: [],
              activeRuns: [
                {
                  runId: "run-active",
                  jobId: "job-active",
                  jobName: "Daily ping",
                  status: "running",
                  stepId: "execute",
                  attempt: 1,
                  maxAttempts: 2,
                  leaseOwner: "worker-a",
                  leaseExpired: true,
                  queuedAtMs: 1,
                  updatedAtMs: 2,
                },
              ],
              recentRuns: [
                {
                  runId: "run-failed",
                  jobId: "job-failed",
                  jobName: "Daily ping",
                  status: "error",
                  queuedAtMs: 1,
                  updatedAtMs: 2,
                },
              ],
            },
          },
          onQueueControl,
        }),
      ),
      container,
    );

    container.querySelector<HTMLButtonElement>('button[aria-label="Cancel active run"]')?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Clear stale lease"]')?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Retry failed run"]')?.click();

    expect(onQueueControl).toHaveBeenCalledWith("cancel", "run-active");
    expect(onQueueControl).toHaveBeenCalledWith("clear-stale", "run-active");
    expect(onQueueControl).toHaveBeenCalledWith("retry", "run-failed");
  });

  it("shows compact task worker health in the top bar", () => {
    const container = document.createElement("div");
    render(
      renderCron(
        createProps({
          status: {
            enabled: true,
            jobs: 1,
            nextWakeAtMs: null,
            queue: {
              path: "/tmp/queue.json",
              total: 1,
              queued: 0,
              running: 1,
              terminal: 0,
              cancelRequested: 0,
              expiredLeases: 1,
              workers: [],
              activeRuns: [
                {
                  runId: "run-worker",
                  jobId: "job-active",
                  jobName: "Daily ping",
                  status: "running",
                  stepId: "execute",
                  attempt: 2,
                  maxAttempts: 3,
                  leaseOwner: "worker-a",
                  leaseExpiresAtMs: Date.now() - 1000,
                  leaseExpired: true,
                  queuedAtMs: 1,
                  startedAtMs: Date.now() - 3000,
                  updatedAtMs: 2,
                },
              ],
              recentRuns: [],
            },
          },
        }),
      ),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).not.toContain("Task workers");
    expect(text).not.toContain("worker-a");
    expect(text).toContain("1 running");
    expect(text).toContain("1 expired");
  });

  it("shows direct tool result source in expanded task activity", () => {
    const container = document.createElement("div");
    const job = {
      ...createJob("job-1"),
      state: {
        lastRunStatus: "ok",
        lastDeliveryStatus: "delivered",
        lastRunResultSource: "direct-tool",
        lastRunResultAdapter: "mining:status",
        lastRunModelUsed: false,
      },
    } satisfies CronJob;
    render(renderCron(createProps({ jobs: [job] })), container);

    expect(container.textContent).toContain("Direct tool result");
    expect(container.textContent).toContain("mining:status - no model used");
  });

  it("opens the shared create-task modal from the global Tasks page", () => {
    const container = document.createElement("div");
    const onCreate = vi.fn();
    render(renderCron(createProps({ onCreate })), container);

    const create = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Create task",
    );
    expect(create).not.toBeUndefined();
    create?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".cron-workspace-form")).toBeNull();
  });

  it("calls onJobsFiltersChange from the compact filters", () => {
    const container = document.createElement("div");
    const onJobsFiltersChange = vi.fn();
    render(renderCron(createProps({ onJobsFiltersChange })), container);

    const search = container.querySelector("input");
    expect(search).not.toBeNull();
    if (!(search instanceof HTMLInputElement)) {
      return;
    }
    search.value = "risk";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsQuery: "risk" });

    const selects = Array.from(container.querySelectorAll("select"));
    const statusSelect = selects.find((select) =>
      Array.from(select.options).some((option) => option.value === "enabled"),
    );
    expect(statusSelect).not.toBeUndefined();
    if (!(statusSelect instanceof HTMLSelectElement)) {
      return;
    }
    statusSelect.value = "disabled";
    statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsEnabledFilter: "disabled" });

    const dateSelect = selects.find((select) =>
      Array.from(select.options).some((option) => option.value === "desc"),
    );
    expect(dateSelect).not.toBeUndefined();
    if (!(dateSelect instanceof HTMLSelectElement)) {
      return;
    }
    dateSelect.value = "asc";
    dateSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onJobsFiltersChange).toHaveBeenCalledWith({
      cronJobsSortBy: "updatedAtMs",
      cronJobsSortDir: "asc",
    });
  });

  it("calls onJobsFiltersReset when reset button is clicked", () => {
    const container = document.createElement("div");
    const onJobsFiltersReset = vi.fn();
    render(
      renderCron(
        createProps({
          jobsQuery: "digest",
          onJobsFiltersReset,
        }),
      ),
      container,
    );

    const reset = container.querySelector('button[data-test-id="cron-jobs-filters-reset"]');
    expect(reset).not.toBeNull();
    reset?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onJobsFiltersReset).toHaveBeenCalledTimes(1);
  });

  it("shows webhook delivery details for jobs", () => {
    const container = document.createElement("div");
    const job = {
      ...createJob("job-2"),
      sessionTarget: "isolated" as const,
      payload: { kind: "agentTurn" as const, message: "do it" },
      delivery: { mode: "webhook" as const, to: "https://example.invalid/cron" },
    };
    render(
      renderCron(
        createProps({
          jobs: [job],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Delivery");
    expect(container.textContent).toContain("webhook");
    expect(container.textContent).toContain("https://example.invalid/cron");
  });

  it("wires the Edit action through the shared task modal path", () => {
    const container = document.createElement("div");
    const onEdit = vi.fn();
    const job = createJob("job-3");

    render(
      renderCron(
        createProps({
          jobs: [job],
          onEdit,
        }),
      ),
      container,
    );

    const editButton = container.querySelector('button[aria-label="Edit task"]');
    expect(editButton).not.toBeNull();
    editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onEdit).toHaveBeenCalledWith(job);
  });

  it("wires Pause, Run, and Delete icon actions", () => {
    const container = document.createElement("div");
    const onToggle = vi.fn();
    const onRun = vi.fn();
    const onRemove = vi.fn();
    const job = createJob("job-actions");
    render(
      renderCron(
        createProps({
          jobs: [job],
          onToggle,
          onRun,
          onRemove,
        }),
      ),
      container,
    );

    const pauseButton = container.querySelector('button[aria-label="Pause task"]');
    expect(pauseButton).not.toBeNull();
    pauseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const runButton = container.querySelector('button[aria-label="Run now"]');
    expect(runButton).not.toBeNull();
    runButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const removeButton = container.querySelector('button[aria-label="Delete task"]');
    expect(removeButton).not.toBeNull();
    removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onToggle).toHaveBeenCalledWith(job, false);
    expect(onRun).toHaveBeenCalledWith(job, "force");
    expect(onRemove).toHaveBeenCalledWith(job);
  });

  it("shows setup target and Resume task for needs-access jobs", () => {
    const container = document.createElement("div");
    const onToggle = vi.fn();
    const job = {
      ...createJob("job-needs-access"),
      enabled: false,
      state: {
        lastStatus: "blocked",
        needsAccess: {
          code: "missing_brave_api_key",
          service: "web_search",
          reason: "Missing Brave Search API key for web_search.",
          setupPath: "/services",
          setupCommand: "fased configure --section web",
          source: "preflight",
          detectedAtMs: 1000,
        },
      },
    } satisfies CronJob;

    render(
      renderCron(
        createProps({
          jobs: [job],
          onToggle,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Missing Brave Search API key for web_search.");
    expect(container.textContent).toContain("Open Web/search setup");
    const setupLink = container.querySelector('a[href="/services#service-web-search"]');
    expect(setupLink).not.toBeNull();
    const resumeButton = container.querySelector('button[aria-label="Resume task"]');
    expect(resumeButton).not.toBeNull();
    resumeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onToggle).toHaveBeenCalledWith(job, true);
  });

  it("names service-specific needs-access setup targets", () => {
    const container = document.createElement("div");
    const jobs = [
      {
        ...createJob("job-github-access"),
        enabled: false,
        state: {
          lastStatus: "blocked",
          needsAccess: {
            code: "missing_github_credential",
            service: "github",
            reason: "Task requires a missing GitHub token or credential.",
            setupPath: "/services#service-github",
            source: "run-output",
            detectedAtMs: 1000,
          },
        },
      },
      {
        ...createJob("job-google-access"),
        enabled: false,
        state: {
          lastStatus: "blocked",
          needsAccess: {
            code: "missing_google_workspace_credential",
            service: "google_workspace",
            reason: "Task requires missing Google Workspace or Gmail access.",
            setupPath: "/services#service-google-workspace",
            source: "run-output",
            detectedAtMs: 1000,
          },
        },
      },
      {
        ...createJob("job-firecrawl-access"),
        enabled: false,
        state: {
          lastStatus: "blocked",
          needsAccess: {
            code: "missing_firecrawl_credential",
            service: "firecrawl",
            reason: "Task requires a missing Firecrawl API key.",
            setupPath: "/services#service-firecrawl",
            source: "run-output",
            detectedAtMs: 1000,
          },
        },
      },
      {
        ...createJob("job-media-browser-access"),
        enabled: false,
        state: {
          lastStatus: "blocked",
          needsAccess: {
            code: "media_browser_unavailable",
            service: "media_browser",
            reason: "Task requires media or browser service setup.",
            setupPath: "/services#service-media-browser",
            source: "run-output",
            detectedAtMs: 1000,
          },
        },
      },
      {
        ...createJob("job-plugin-service-access"),
        enabled: false,
        state: {
          lastStatus: "blocked",
          needsAccess: {
            code: "plugin_service_unavailable",
            service: "plugin_services",
            reason: "Task requires a plugin-provided service that is not available.",
            setupPath: "/services#service-plugin-services",
            source: "run-output",
            detectedAtMs: 1000,
          },
        },
      },
      {
        ...createJob("job-skill-library-access"),
        enabled: false,
        state: {
          lastStatus: "blocked",
          needsAccess: {
            code: "missing_skill_tool",
            service: "skills",
            reason: "Task requires a missing skill.",
            setupPath: "/skills#skill-library",
            source: "preflight",
            detectedAtMs: 1000,
          },
        },
      },
      {
        ...createJob("job-agent-skill-access"),
        enabled: false,
        state: {
          lastStatus: "blocked",
          needsAccess: {
            code: "skill_action_not_allowed",
            service: "agent_skills",
            reason: "Agent skills block this skill.",
            setupPath: "/agents#agent-access",
            source: "preflight",
            detectedAtMs: 1000,
          },
        },
      },
      {
        ...createJob("job-wallet-grant-access"),
        enabled: false,
        state: {
          lastStatus: "blocked",
          needsAccess: {
            code: "wallet_policy_blocked",
            service: "wallet_grants",
            reason: "Wallet grant is missing.",
            setupPath: "/wallet#wallet-skill-grants",
            source: "run-output",
            detectedAtMs: 1000,
          },
        },
      },
    ] satisfies CronJob[];

    render(renderCron(createProps({ jobs })), container);

    expect(container.textContent).toContain("Open GitHub setup");
    expect(container.textContent).toContain("Open Google Workspace setup");
    expect(container.textContent).toContain("Open Firecrawl setup");
    expect(container.textContent).toContain("Open Media/browser setup");
    expect(container.textContent).toContain("Open Plugin services");
    expect(container.textContent).toContain("Open Skill Library");
    expect(container.textContent).toContain("Open Agent Skills");
    expect(container.textContent).toContain("Open Skill Grants");
    expect(container.querySelector('a[href="/services#service-github"]')).not.toBeNull();
    expect(container.querySelector('a[href="/services#service-google-workspace"]')).not.toBeNull();
    expect(container.querySelector('a[href="/services#service-firecrawl"]')).not.toBeNull();
    expect(container.querySelector('a[href="/services#service-media-browser"]')).not.toBeNull();
    expect(container.querySelector('a[href="/services#service-plugin-services"]')).not.toBeNull();
    expect(container.querySelector('a[href="/skills#skill-library"]')).not.toBeNull();
    expect(container.querySelector('a[href="/agents#agent-access"]')).not.toBeNull();
    expect(container.querySelector('a[href="/wallet#wallet-skill-grants"]')).not.toBeNull();
  });

  it("disables run detail recovery controls while queue work is busy", () => {
    const container = document.createElement("div");
    render(
      renderCronRunDetailModal({
        detail: {
          runId: "run-1",
          jobId: "job-1",
          jobName: "Market watch",
          status: "error",
          leaseExpired: false,
          stepDetails: [],
          controls: { canCancel: false, canRetry: true, canClearStaleLease: false },
          execution: {},
        },
        loading: false,
        busy: true,
        error: null,
        onClose: vi.fn(),
      }),
      container,
    );

    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Retry run",
    );
    expect(retry).not.toBeUndefined();
    expect(retry?.disabled).toBe(true);
  });

  it("shows step leases, attempts, and step control hints in run detail", () => {
    const container = document.createElement("div");
    const onQueueControl = vi.fn();
    render(
      renderCronRunDetailModal({
        detail: {
          runId: "run-lease",
          jobId: "job-lease",
          jobName: "Lease watch",
          status: "running",
          leaseExpired: true,
          activeStep: {
            id: "execute",
            status: "running",
            attempt: 2,
            maxAttempts: 3,
            createdAtMs: Date.now() - 5000,
            startedAtMs: Date.now() - 3000,
            leaseOwner: "worker-a",
            leaseExpiresAtMs: Date.now() - 1000,
          },
          stepDetails: [
            {
              id: "execute",
              status: "running",
              attempt: 2,
              maxAttempts: 3,
              retryPolicy: {
                maxAttempts: 3,
                retryDelayMs: 1000,
                backoffMultiplier: 2,
                retryOn: "error-or-lease-expired",
              },
              resume: {
                resumable: true,
                checkpointKeys: ["phase"],
                reason: "Worker lease resumed with checkpoint data.",
                updatedAtMs: Date.now() - 1500,
              },
              createdAtMs: Date.now() - 5000,
              startedAtMs: Date.now() - 3000,
              leaseOwner: "worker-a",
              leaseExpiresAtMs: Date.now() - 1000,
              leaseExpired: true,
              leaseRemainingMs: -1000,
              checkpoint: { phase: "execute" },
              control: {
                available: true,
                action: "clear-stale",
                label: "Clear stale lease",
                reason: "This running step lease expired; clear it to requeue the run.",
              },
            },
          ],
          controls: { canCancel: true, canRetry: false, canClearStaleLease: true },
          execution: {},
        },
        loading: false,
        busy: false,
        error: null,
        onClose: vi.fn(),
        onQueueControl,
      }),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Active step");
    expect(text).toContain("execute");
    expect(text).toContain("Lease owner");
    expect(text).toContain("worker-a");
    expect(text).toContain("attempt 2/3");
    expect(text).toContain("Retry policy");
    expect(text).toContain("error-or-lease-expired");
    expect(text).toContain("Resume");
    expect(text).toContain("resumable");
    expect(text).toContain("Clear stale lease");
    container
      .querySelector<HTMLButtonElement>(".cron-run-step__control button")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onQueueControl).toHaveBeenCalledWith("clear-stale", "run-lease");
  });

  it("shows graph source repair decisions in run detail", () => {
    const container = document.createElement("div");
    render(
      renderCronRunDetailModal({
        detail: {
          runId: "run-repair",
          jobId: "job-repair",
          jobName: "Source repair watch",
          status: "ok",
          leaseExpired: false,
          stepDetails: [],
          controls: { canCancel: false, canRetry: false, canClearStaleLease: false },
          execution: {},
          repairReplay: {
            runId: "run-repair",
            parentRunId: "run-parent",
            graphRevision: 2,
            parentRevision: 1,
            repairRevision: 1,
            repairAttempt: 1,
            maxRepairAttempts: 2,
            repairedAtMs: 1,
            reusedNodeIds: ["collect-data"],
            invalidatedNodeIds: [
              "source-fetch-repair-web-fetch-for-web-fetch",
              "source-merge",
              "model-analysis",
            ],
            requeuedNodeIds: [
              "source-fetch-repair-web-fetch-for-web-fetch",
              "source-merge",
              "model-analysis",
            ],
            reason:
              "replaced source-fetch-web-fetch with source-fetch-repair-web-fetch-for-web-fetch",
          },
          job: {
            id: "job-repair",
            name: "Source repair watch",
            enabled: true,
            createdAtMs: 0,
            updatedAtMs: 0,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "agentTurn", message: "check sources" },
            state: {
              lastRunCheckpoint: { runId: "run-repair" },
              lastGraphRepairs: [
                {
                  action: "replace_source",
                  nodeId: "source-fetch-repair-web-fetch-for-web-fetch",
                  toolName: "web_fetch",
                  reason: "Weak source quality with unavailable sources.",
                  createdAtMs: 1,
                  replacesNodeId: "source-fetch-web-fetch",
                  applied: true,
                  applyReason:
                    "replaced source-fetch-web-fetch with source-fetch-repair-web-fetch-for-web-fetch",
                },
                {
                  action: "add_source",
                  nodeId: "source-fetch-repair-web-search-for-web-search",
                  toolName: "web_search",
                  reason: "Optional enrichment source failed.",
                  createdAtMs: 1,
                  applied: true,
                  applyReason: "added source-fetch-repair-web-search-for-web-search",
                },
              ],
            },
          },
        },
        loading: false,
        busy: false,
        error: null,
        onClose: vi.fn(),
      }),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Source repair");
    expect(text).toContain("Replace source-fetch-web-fetch");
    expect(text).toContain("source-fetch-repair-web-fetch-for-web-fetch");
    expect(text).toContain("Add source-fetch-repair-web-search-for-web-search");
    expect(text).toContain("applied");
    expect(text).toContain("Repair replay");
    expect(text).toContain("Graph revision 2");
    expect(text).toContain("Reused 1 checkpoint");
    expect(text).toContain("Invalidated 3 nodes");
  });

  it("sends source repair actions from run detail", async () => {
    const container = document.createElement("div");
    const onRepair = vi.fn();
    const onNavigate = vi.fn();
    const job: CronJob = {
      ...createJob("job-repair"),
      state: {
        lastRunCheckpoint: { runId: "run-repair" },
        lastGraphRepairStop: {
          code: "needs_user_source",
          reason: "Need a trusted source before retrying.",
          sourceNodeId: "source-fetch-web-search",
          atMs: 1_000,
        },
      },
    };

    render(
      renderCronRunDetailModal({
        detail: {
          runId: "run-repair",
          jobId: job.id,
          jobName: job.name,
          status: "blocked",
          leaseExpired: false,
          stepDetails: [],
          controls: { canCancel: false, canRetry: false, canClearStaleLease: false },
          execution: {},
          recommendedRepairActions: [
            {
              action: "configure_source",
              label: "Configure source",
              reason: "Search access is missing.",
              priority: "primary",
              setupPath: "/services",
            },
            {
              action: "retry_replacement",
              label: "Retry with replacement",
              reason: "A required source was weak.",
              priority: "primary",
              sourceNodeId: "source-fetch-web-search",
            },
          ],
          job: runDetailJob(job),
        },
        loading: false,
        busy: false,
        error: null,
        onClose: vi.fn(),
        onRepair,
        onNavigate,
      }),
      container,
    );

    expect(container.textContent).toContain("Repair actions");
    expect(container.textContent).toContain("Recommended next action");
    expect(container.textContent).toContain("A required source was weak.");
    const input = container.querySelector<HTMLInputElement>("[data-run-trusted-source]");
    expect(input).not.toBeNull();
    input!.value = "https://example.com/source";

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    buttons.find((button) => button.textContent?.includes("Configure source"))?.click();
    await Promise.resolve();
    buttons.find((button) => button.textContent?.includes("Add trusted source"))?.click();
    buttons.find((button) => button.textContent?.includes("Retry with replacement"))?.click();
    buttons.find((button) => button.textContent?.includes("Stop source path"))?.click();

    expect(onRepair).toHaveBeenCalledWith(job, "configure_source");
    expect(onNavigate).toHaveBeenCalledWith("services");
    expect(onRepair).toHaveBeenCalledWith(job, "add_trusted_source", {
      source: "https://example.com/source",
    });
    expect(onRepair).toHaveBeenCalledWith(job, "retry_replacement");
    expect(onRepair).toHaveBeenCalledWith(job, "stop_source_path", {
      sourceNodeId: "source-fetch-web-search",
    });
  });

  it("shows task-room evidence and approval action in run detail", () => {
    const container = document.createElement("div");
    const onApproveCoordination = vi.fn();
    const job: CronJob = {
      ...createJob("job-coordinate-detail"),
      executionPolicy: {
        executionMode: "agent-turn",
        coordination: {
          mode: "consult",
          agents: ["research"],
          requireApproval: true,
        },
      },
      state: {},
    };

    render(
      renderCronRunDetailModal({
        detail: {
          runId: "run-coordinate",
          jobId: job.id,
          jobName: job.name,
          status: "blocked",
          leaseExpired: false,
          stepDetails: [
            {
              id: "coordinate-agents",
              status: "blocked",
              attempt: 1,
              maxAttempts: 1,
              createdAtMs: 1,
              leaseExpired: false,
              checkpoint: {
                coordinationEvidence: [
                  {
                    agentId: "research",
                    mode: "consult",
                    status: "needs_approval",
                    summary: "Waiting for approval.",
                  },
                ],
              },
              control: {
                available: false,
                label: "No action",
                reason: "No queue action is available.",
              },
            },
          ],
          controls: { canCancel: false, canRetry: false, canClearStaleLease: false },
          execution: {},
          job: runDetailJob(job),
        },
        loading: false,
        busy: false,
        error: null,
        onClose: vi.fn(),
        onApproveCoordination,
      }),
      container,
    );

    expect(container.textContent).toContain("Task-room evidence");
    expect(container.textContent).toContain("research");
    expect(container.textContent).toContain("needs_approval");
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("Approve coordination"),
    );
    button?.click();
    expect(onApproveCoordination).toHaveBeenCalledWith(job);
  });

  it("uses recommended setup paths for run-detail configure actions", () => {
    const container = document.createElement("div");
    const job: CronJob = {
      ...createJob("job-configure-source"),
      state: {
        lastRunCheckpoint: { runId: "run-configure-source" },
        lastGraphRepairStop: {
          code: "source_access_missing",
          reason: "Provider source access is missing.",
          atMs: 1_000,
        },
      },
    };

    render(
      renderCronRunDetailModal({
        detail: {
          runId: "run-configure-source",
          jobId: job.id,
          jobName: job.name,
          status: "blocked",
          leaseExpired: false,
          stepDetails: [],
          controls: { canCancel: false, canRetry: false, canClearStaleLease: false },
          execution: {},
          recommendedRepairActions: [
            {
              action: "configure_source",
              label: "Configure source",
              reason: "Provider auth is missing.",
              priority: "primary",
              setupPath: "/providers",
            },
          ],
          job: runDetailJob(job),
        },
        loading: false,
        busy: false,
        error: null,
        basePath: "/control",
        onClose: vi.fn(),
      }),
      container,
    );

    const configureLink = Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find(
      (link) => link.textContent?.includes("Configure source"),
    );
    expect(configureLink?.getAttribute("href")).toBe("/control/providers");
  });
});
