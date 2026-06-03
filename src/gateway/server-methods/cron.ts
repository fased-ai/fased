import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import { readCronTaskRunDetail } from "../../cron/run-detail.js";
import {
  readCronRunLogEntriesPage,
  readCronRunLogEntriesPageAll,
  resolveCronRunLogPath,
} from "../../cron/run-log.js";
import type { CronJobCreate, CronJobPatch } from "../../cron/types.js";
import { validateScheduleTimestamp } from "../../cron/validate-timestamp.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateCronAddParams,
  validateCronListParams,
  validateCronQueueControlParams,
  validateCronRepairParams,
  validateCronRemoveParams,
  validateCronRunDetailParams,
  validateCronRunParams,
  validateCronRunsParams,
  validateCronSourcesListParams,
  validateCronSourcesRemoveParams,
  validateCronSourcesUpdateParams,
  validateCronStatusParams,
  validateCronUpdateParams,
  validateWakeParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const cronHandlers: GatewayRequestHandlers = {
  wake: ({ params, respond, context }) => {
    if (!validateWakeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid wake params: ${formatValidationErrors(validateWakeParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      mode: "now" | "next-heartbeat";
      text: string;
    };
    const result = context.cron.wake({ mode: p.mode, text: p.text });
    respond(true, result, undefined);
  },
  "cron.list": async ({ params, respond, context }) => {
    if (!validateCronListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.list params: ${formatValidationErrors(validateCronListParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      includeDisabled?: boolean;
      limit?: number;
      offset?: number;
      query?: string;
      enabled?: "all" | "enabled" | "disabled";
      sortBy?: "nextRunAtMs" | "updatedAtMs" | "name";
      sortDir?: "asc" | "desc";
    };
    const page = await context.cron.listPage({
      includeDisabled: p.includeDisabled,
      limit: p.limit,
      offset: p.offset,
      query: p.query,
      enabled: p.enabled,
      sortBy: p.sortBy,
      sortDir: p.sortDir,
    });
    respond(true, page, undefined);
  },
  "cron.status": async ({ params, respond, context }) => {
    if (!validateCronStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.status params: ${formatValidationErrors(validateCronStatusParams.errors)}`,
        ),
      );
      return;
    }
    const status = await context.cron.status();
    respond(true, status, undefined);
  },
  "cron.add": async ({ params, respond, context }) => {
    const normalized = normalizeCronJobCreate(params) ?? params;
    if (!validateCronAddParams(normalized)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.add params: ${formatValidationErrors(validateCronAddParams.errors)}`,
        ),
      );
      return;
    }
    const jobCreate = normalized as unknown as CronJobCreate;
    const timestampValidation = validateScheduleTimestamp(jobCreate.schedule);
    if (!timestampValidation.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message),
      );
      return;
    }
    const job = await context.cron.add(jobCreate);
    respond(true, job, undefined);
  },
  "cron.update": async ({ params, respond, context }) => {
    const normalizedPatch = normalizeCronJobPatch((params as { patch?: unknown } | null)?.patch);
    const candidate =
      normalizedPatch && typeof params === "object" && params !== null
        ? { ...params, patch: normalizedPatch }
        : params;
    if (!validateCronUpdateParams(candidate)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.update params: ${formatValidationErrors(validateCronUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const p = candidate as {
      id?: string;
      jobId?: string;
      patch: Record<string, unknown>;
    };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.update params: missing id"),
      );
      return;
    }
    const patch = p.patch as unknown as CronJobPatch;
    if (patch.schedule) {
      const timestampValidation = validateScheduleTimestamp(patch.schedule);
      if (!timestampValidation.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message),
        );
        return;
      }
    }
    const job = await context.cron.update(jobId, patch);
    respond(true, job, undefined);
  },
  "cron.repair": async ({ params, respond, context }) => {
    if (!validateCronRepairParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.repair params: ${formatValidationErrors(validateCronRepairParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      id?: string;
      jobId?: string;
      action: Parameters<typeof context.cron.repair>[1]["action"];
      source?: string;
      sourceNodeId?: string;
    };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.repair params: missing id"),
      );
      return;
    }
    const result = await context.cron.repair(jobId, {
      action: p.action,
      source: p.source,
      sourceNodeId: p.sourceNodeId,
    });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.INVALID_REQUEST, result.reason),
    );
  },
  "cron.sources.list": async ({ params, respond, context }) => {
    if (!validateCronSourcesListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.sources.list params: ${formatValidationErrors(
            validateCronSourcesListParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as {
      includeInactive?: boolean;
      agentId?: string;
      sessionKey?: string;
      taskType?: string;
      query?: string;
    };
    const result = await context.cron.sourcesList(p);
    respond(true, result, undefined);
  },
  "cron.sources.update": async ({ params, respond, context }) => {
    if (!validateCronSourcesUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.sources.update params: ${formatValidationErrors(
            validateCronSourcesUpdateParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as { id: string; active: boolean };
    const result = await context.cron.sourcesUpdate(p.id, { active: p.active });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.NOT_FOUND, result.reason),
    );
  },
  "cron.sources.remove": async ({ params, respond, context }) => {
    if (!validateCronSourcesRemoveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.sources.remove params: ${formatValidationErrors(
            validateCronSourcesRemoveParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as { id: string };
    const result = await context.cron.sourcesRemove(p.id);
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.NOT_FOUND, result.reason),
    );
  },
  "cron.remove": async ({ params, respond, context }) => {
    if (!validateCronRemoveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.remove params: ${formatValidationErrors(validateCronRemoveParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { id?: string; jobId?: string };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.remove params: missing id"),
      );
      return;
    }
    const result = await context.cron.remove(jobId);
    respond(true, result, undefined);
  },
  "cron.run": async ({ params, respond, context }) => {
    if (!validateCronRunParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.run params: ${formatValidationErrors(validateCronRunParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { id?: string; jobId?: string; mode?: "due" | "force" };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.run params: missing id"),
      );
      return;
    }
    const result = await context.cron.run(jobId, p.mode ?? "force");
    respond(true, result, undefined);
  },
  "cron.queue.cancel": async ({ params, respond, context }) => {
    if (!validateCronQueueControlParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.queue.cancel params: ${formatValidationErrors(
            validateCronQueueControlParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as { runId: string; reason?: string };
    const result = await context.cron.queueCancel(p.runId, p.reason);
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.INVALID_REQUEST, result.reason),
    );
  },
  "cron.queue.retry": async ({ params, respond, context }) => {
    if (!validateCronQueueControlParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.queue.retry params: ${formatValidationErrors(
            validateCronQueueControlParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as { runId: string; reason?: string };
    const result = await context.cron.queueRetry(p.runId, p.reason);
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.INVALID_REQUEST, result.reason),
    );
  },
  "cron.queue.clearStale": async ({ params, respond, context }) => {
    if (!validateCronQueueControlParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.queue.clearStale params: ${formatValidationErrors(
            validateCronQueueControlParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as { runId: string; reason?: string };
    const result = await context.cron.queueClearStale(p.runId, p.reason);
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.INVALID_REQUEST, result.reason),
    );
  },
  "cron.runDetail": async ({ params, respond, context }) => {
    if (!validateCronRunDetailParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.runDetail params: ${formatValidationErrors(
            validateCronRunDetailParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as { runId: string };
    const jobs = await context.cron.list({ includeDisabled: true });
    const detail = await readCronTaskRunDetail({
      storePath: context.cronStorePath,
      runId: p.runId,
      nowMs: Date.now(),
      jobs,
    });
    if (!detail) {
      respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, "Task run not found."));
      return;
    }
    respond(true, detail, undefined);
  },
  "cron.runs": async ({ params, respond, context }) => {
    if (!validateCronRunsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.runs params: ${formatValidationErrors(validateCronRunsParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      scope?: "job" | "all";
      id?: string;
      jobId?: string;
      limit?: number;
      offset?: number;
      statuses?: Array<"ok" | "error" | "skipped" | "blocked">;
      status?: "all" | "ok" | "error" | "skipped" | "blocked";
      deliveryStatuses?: Array<"delivered" | "not-delivered" | "unknown" | "not-requested">;
      deliveryStatus?: "delivered" | "not-delivered" | "unknown" | "not-requested";
      query?: string;
      sortDir?: "asc" | "desc";
    };
    const explicitScope = p.scope;
    const jobId = p.id ?? p.jobId;
    const scope: "job" | "all" = explicitScope ?? (jobId ? "job" : "all");
    if (scope === "job" && !jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.runs params: missing id"),
      );
      return;
    }
    if (scope === "all") {
      const jobs = await context.cron.list({ includeDisabled: true });
      const jobNameById = Object.fromEntries(
        jobs
          .filter((job) => typeof job.id === "string" && typeof job.name === "string")
          .map((job) => [job.id, job.name]),
      );
      const page = await readCronRunLogEntriesPageAll({
        storePath: context.cronStorePath,
        limit: p.limit,
        offset: p.offset,
        statuses: p.statuses,
        status: p.status,
        deliveryStatuses: p.deliveryStatuses,
        deliveryStatus: p.deliveryStatus,
        query: p.query,
        sortDir: p.sortDir,
        jobNameById,
      });
      respond(true, page, undefined);
      return;
    }
    let logPath: string;
    try {
      logPath = resolveCronRunLogPath({
        storePath: context.cronStorePath,
        jobId: jobId as string,
      });
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.runs params: invalid id"),
      );
      return;
    }
    const page = await readCronRunLogEntriesPage(logPath, {
      limit: p.limit,
      offset: p.offset,
      jobId: jobId as string,
      statuses: p.statuses,
      status: p.status,
      deliveryStatuses: p.deliveryStatuses,
      deliveryStatus: p.deliveryStatus,
      query: p.query,
      sortDir: p.sortDir,
    });
    respond(true, page, undefined);
  },
};
