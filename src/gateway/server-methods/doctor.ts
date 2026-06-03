import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig, type FasedAgentConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import {
  buildMemoryInventory,
  type DoctorMemoryInventoryPayload,
  type DoctorMemoryRepairPreviewPayload,
  type DoctorMemoryValidationPayload,
  previewMemoryInventoryRepair,
  validateMemoryInventory,
} from "../../memory/inventory.js";
import { executeMemoryRepair } from "../../memory/repair-executor.js";
import type { MemoryProviderStatus } from "../../memory/types.js";
import {
  buildMemoryWiki,
  getMemoryWikiStatus,
  type MemoryWikiBuildResult,
  type MemoryWikiStatus,
} from "../../memory/wiki.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatError } from "../server-utils.js";
import { logMutatingAdminRpcAudit } from "./mutating-admin-rpc-audit.js";
import type { GatewayRequestHandlers } from "./types.js";

export type DoctorMemoryStatusPayload = {
  agentId: string;
  provider?: string;
  embedding: {
    ok: boolean;
    error?: string;
  };
  dreaming?: DoctorMemoryDreamingStatusPayload;
};

export type DoctorMemoryDreamingStatusPayload = {
  enabled: boolean;
  timezone?: string;
  verboseLogging: boolean;
  storageMode: "inline" | "separate" | "both";
  separateReports: boolean;
  shortTermCount: number;
  recallSignalCount: number;
  dailySignalCount: number;
  totalSignalCount: number;
  phaseSignalCount: number;
  lightPhaseHitCount: number;
  remPhaseHitCount: number;
  promotedTotal: number;
  promotedToday: number;
  storeError?: string;
  phaseSignalError?: string;
  phases: {
    light: DoctorMemoryDreamingPhaseStatus & {
      lookbackDays: number;
      limit: number;
    };
    deep: DoctorMemoryDreamingPhaseStatus & {
      limit: number;
      minScore: number;
      minRecallCount: number;
      minUniqueQueries: number;
      recencyHalfLifeDays: number;
      maxAgeDays?: number;
    };
    rem: DoctorMemoryDreamingPhaseStatus & {
      lookbackDays: number;
      limit: number;
      minPatternStrength: number;
    };
  };
};

type DoctorMemoryDreamingPhaseStatus = {
  enabled: boolean;
  cron: string;
  managedCronPresent: boolean;
  nextRunAtMs?: number;
};

export const doctorHandlers: GatewayRequestHandlers = {
  "doctor.memory.status": async ({ params, respond }) => {
    const cfg = loadConfig();
    const agentId = resolveMemoryAgentId(params, cfg);
    const { manager, error } = await getMemorySearchManager({
      cfg,
      agentId,
      purpose: "status",
    });
    if (!manager) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        embedding: {
          ok: false,
          error: error ?? "memory search unavailable",
        },
        dreaming: buildMemoryCoreDreamingStatus(cfg),
      };
      respond(true, payload, undefined);
      return;
    }

    try {
      const status = manager.status();
      let embedding = await manager.probeEmbeddingAvailability();
      if (!embedding.ok && !embedding.error) {
        embedding = { ok: false, error: "memory embeddings unavailable" };
      }
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        provider: status.provider,
        embedding,
        dreaming: buildMemoryCoreDreamingStatus(cfg),
      };
      respond(true, payload, undefined);
    } catch (err) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        embedding: {
          ok: false,
          error: `gateway memory probe failed: ${formatError(err)}`,
        },
        dreaming: buildMemoryCoreDreamingStatus(cfg),
      };
      respond(true, payload, undefined);
    } finally {
      await manager.close?.().catch(() => {});
    }
  },
  "doctor.memory.inventory": async ({ params, respond }) => {
    const cfg = loadConfig();
    const agentId = resolveMemoryAgentId(params, cfg);
    try {
      const payload = await loadMemoryInventory(agentId, cfg);
      respond(true, payload, undefined);
    } catch (err) {
      const payload: DoctorMemoryInventoryPayload = {
        agentId,
        workspace: {
          path: "",
          exists: false,
          memoryRoots: [],
        },
        backend: {
          configured: "builtin",
          citations: "auto",
          error: `gateway memory inventory failed: ${formatError(err)}`,
        },
        qmd: { enabled: false },
        sessionMemory: {
          hookConfigured: false,
          enabled: false,
          memoryDir: { path: "", exists: false, kind: "error" },
        },
        memoryPlugin: {
          configuredSlot: null,
          enabled: false,
          registryLoaded: false,
          reason: "inventory failed",
        },
      };
      respond(true, payload, undefined);
    }
  },
  "doctor.memory.validate": async ({ params, respond }) => {
    const cfg = loadConfig();
    const agentId = resolveMemoryAgentId(params, cfg);
    try {
      const inventory = await loadMemoryInventory(agentId, cfg);
      const payload: DoctorMemoryValidationPayload = validateMemoryInventory(inventory);
      respond(true, payload, undefined);
    } catch (err) {
      const payload: DoctorMemoryValidationPayload = {
        agentId,
        ok: false,
        summary: { errors: 1, warnings: 0, info: 0 },
        findings: [
          {
            severity: "error",
            code: "validation.failed",
            area: "backend",
            message: `gateway memory validation failed: ${formatError(err)}`,
          },
        ],
      };
      respond(true, payload, undefined);
    }
  },
  "doctor.memory.wiki.status": async ({ params, respond }) => {
    const cfg = loadConfig();
    const agentId = resolveMemoryAgentId(params, cfg);
    try {
      const payload: MemoryWikiStatus = await getMemoryWikiStatus({ cfg, agentId });
      respond(true, payload, undefined);
    } catch (err) {
      const payload: MemoryWikiStatus = {
        agentId,
        outputDir: "",
        indexPath: "",
        sources: 0,
        pages: 0,
        built: false,
        error: `memory wiki status failed: ${formatError(err)}`,
      };
      respond(true, payload, undefined);
    }
  },
  "doctor.memory.wiki.rebuild": async ({ params, respond, client, context }) => {
    const cfg = loadConfig();
    const agentId = resolveMemoryAgentId(params, cfg);
    try {
      const payload: MemoryWikiBuildResult = await buildMemoryWiki({ cfg, agentId });
      logMutatingAdminRpcAudit({
        context,
        client,
        method: "doctor.memory.wiki.rebuild",
        outcome: "succeeded",
        details: {
          agentId,
          sources: payload.sources,
          pages: payload.pages,
        },
      });
      respond(true, payload, undefined);
    } catch (err) {
      logMutatingAdminRpcAudit({
        context,
        client,
        method: "doctor.memory.wiki.rebuild",
        outcome: "failed",
        details: { agentId, reason: "rebuild_failed" },
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `memory wiki rebuild failed: ${formatError(err)}`),
      );
    }
  },
  "doctor.memory.repair.preview": async ({ params, respond }) => {
    const cfg = loadConfig();
    const agentId = resolveMemoryAgentId(params, cfg);
    try {
      const inventory = await loadMemoryInventory(agentId, cfg);
      const payload: DoctorMemoryRepairPreviewPayload = previewMemoryInventoryRepair(inventory);
      respond(true, payload, undefined);
    } catch (err) {
      const payload: DoctorMemoryRepairPreviewPayload = {
        agentId,
        dryRun: true,
        ok: false,
        validation: { errors: 1, warnings: 0, info: 0 },
        summary: { proposals: 1, supported: 0, blocked: 1 },
        proposals: [
          {
            id: "memory-repair-preview-1",
            area: "backend",
            sourceCode: "repair.preview.failed",
            severity: "error",
            action: "manual_review",
            description: `gateway memory repair preview failed: ${formatError(err)}`,
            dryRun: true,
            wouldMutate: true,
            requiresOperatorWrite: true,
            supported: false,
            blockReason: "preview failed",
          },
        ],
      };
      respond(true, payload, undefined);
    }
  },
  "doctor.memory.repair.execute": async ({ params, respond, client, context }) => {
    const parsed = parseMemoryRepairExecuteParams(params);
    if (!parsed.ok) {
      logMutatingAdminRpcAudit({
        context,
        client,
        method: "doctor.memory.repair.execute",
        outcome: "denied",
        details: { reason: "invalid_params" },
      });
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsed.error));
      return;
    }

    const cfg = loadConfig();
    const agentId = parsed.value.agentId ?? resolveDefaultAgentId(cfg);
    try {
      const result = await executeMemoryRepair({
        cfg,
        agentId,
        proposalIds: parsed.value.proposalIds,
        surface: "dashboard-admin",
        confirmation: "confirmation-token",
        allowWrites: true,
        ...(parsed.value.executionId ? { executionId: parsed.value.executionId } : {}),
        ...(parsed.value.acceptedPreviewFingerprint
          ? { acceptedPreviewFingerprint: parsed.value.acceptedPreviewFingerprint }
          : {}),
        ...(parsed.value.acceptedAuditPlanFingerprint
          ? { acceptedAuditPlanFingerprint: parsed.value.acceptedAuditPlanFingerprint }
          : {}),
        acceptCurrentPreview: parsed.value.acceptCurrentPreview,
        acceptCurrentAuditPlan: parsed.value.acceptCurrentAuditPlan,
      });
      logMutatingAdminRpcAudit({
        context,
        client,
        method: "doctor.memory.repair.execute",
        outcome:
          result.status === "success"
            ? "succeeded"
            : result.status === "denied"
              ? "denied"
              : "failed",
        details: {
          agentId,
          executionId: result.executionId,
          status: result.status,
          selected: result.summary.selected,
          writeSucceeded: result.summary.writeSucceeded,
        },
      });
      if (result.status === "denied") {
        respond(
          false,
          result,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            result.reasons[0] ?? "memory repair execution denied",
            { details: { reasons: result.reasons } },
          ),
        );
        return;
      }
      respond(true, result, undefined);
    } catch (err) {
      logMutatingAdminRpcAudit({
        context,
        client,
        method: "doctor.memory.repair.execute",
        outcome: "failed",
        details: { agentId, reason: "executor_failed" },
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `memory repair execution failed: ${formatError(err)}`),
      );
    }
  },
};

type MemoryRepairExecuteParams = {
  agentId?: string;
  proposalIds: string[];
  acceptedPreviewFingerprint?: string;
  acceptedAuditPlanFingerprint?: string;
  acceptCurrentPreview: boolean;
  acceptCurrentAuditPlan: boolean;
  executionId?: string;
};

function parseMemoryRepairExecuteParams(
  params: Record<string, unknown>,
): { ok: true; value: MemoryRepairExecuteParams } | { ok: false; error: string } {
  const proposalIds = Array.isArray(params.proposalIds)
    ? params.proposalIds
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean)
    : [];
  if (proposalIds.length === 0) {
    return { ok: false, error: "doctor.memory.repair.execute requires proposalIds[]" };
  }
  if (params.confirm !== "EXECUTE_MEMORY_REPAIR") {
    return {
      ok: false,
      error: 'doctor.memory.repair.execute requires confirm="EXECUTE_MEMORY_REPAIR"',
    };
  }
  const acceptedPreviewFingerprint = optionalString(params.acceptedPreviewFingerprint);
  const acceptedAuditPlanFingerprint = optionalString(params.acceptedAuditPlanFingerprint);
  const acceptCurrentPreview = params.acceptCurrentPreview === true;
  const acceptCurrentAuditPlan = params.acceptCurrentAuditPlan === true;
  if (!acceptedPreviewFingerprint && !acceptCurrentPreview) {
    return {
      ok: false,
      error:
        "doctor.memory.repair.execute requires acceptedPreviewFingerprint or acceptCurrentPreview",
    };
  }
  if (!acceptedAuditPlanFingerprint && !acceptCurrentAuditPlan) {
    return {
      ok: false,
      error:
        "doctor.memory.repair.execute requires acceptedAuditPlanFingerprint or acceptCurrentAuditPlan",
    };
  }
  return {
    ok: true,
    value: {
      proposalIds,
      acceptCurrentPreview,
      acceptCurrentAuditPlan,
      ...(optionalString(params.agentId) ? { agentId: optionalString(params.agentId) } : {}),
      ...(optionalString(params.executionId)
        ? { executionId: optionalString(params.executionId) }
        : {}),
      ...(acceptedPreviewFingerprint ? { acceptedPreviewFingerprint } : {}),
      ...(acceptedAuditPlanFingerprint ? { acceptedAuditPlanFingerprint } : {}),
    },
  };
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readBoolean(record: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

function readString(record: Record<string, unknown>, key: string, fallback = ""): string {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readInt(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function readScore(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

function readStorageMode(record: Record<string, unknown>): "inline" | "separate" | "both" {
  const value = readString(record, "storageMode", "inline");
  return value === "separate" || value === "both" ? value : "inline";
}

function readDreamingPhaseBase(record: Record<string, unknown>): DoctorMemoryDreamingPhaseStatus {
  const nextRunAtMsValue = record.nextRunAtMs;
  const nextRunAtMs =
    typeof nextRunAtMsValue === "number" && Number.isFinite(nextRunAtMsValue)
      ? nextRunAtMsValue
      : undefined;
  return {
    enabled: readBoolean(record, "enabled"),
    cron: readString(record, "cron"),
    managedCronPresent: readBoolean(record, "managedCronPresent"),
    ...(nextRunAtMs !== undefined ? { nextRunAtMs } : {}),
  };
}

function buildMemoryCoreDreamingStatus(cfg: FasedAgentConfig): DoctorMemoryDreamingStatusPayload {
  const memorySlot = cfg.plugins?.slots?.memory?.trim().toLowerCase();
  const memoryCoreDisabled =
    cfg.plugins?.enabled === false ||
    memorySlot === "none" ||
    cfg.plugins?.entries?.["memory-core"]?.enabled === false;
  const memoryCoreEntry = asRecord(cfg.plugins?.entries?.["memory-core"]?.config);
  const dreaming = asRecord(memoryCoreEntry.dreaming);
  const phases = asRecord(dreaming.phases);
  const light = asRecord(phases.light);
  const deep = asRecord(phases.deep);
  const rem = asRecord(phases.rem);
  const timezone = readString(dreaming, "timezone");
  return {
    enabled: !memoryCoreDisabled && readBoolean(dreaming, "enabled"),
    ...(timezone ? { timezone } : {}),
    verboseLogging: readBoolean(dreaming, "verboseLogging"),
    storageMode: readStorageMode(dreaming),
    separateReports: readBoolean(dreaming, "separateReports"),
    shortTermCount: 0,
    recallSignalCount: 0,
    dailySignalCount: 0,
    totalSignalCount: 0,
    phaseSignalCount: 0,
    lightPhaseHitCount: 0,
    remPhaseHitCount: 0,
    promotedTotal: 0,
    promotedToday: 0,
    ...(memoryCoreDisabled ? { storeError: "memory-core plugin is disabled" } : {}),
    phases: {
      light: {
        ...readDreamingPhaseBase(light),
        lookbackDays: readInt(light, "lookbackDays", 7),
        limit: readInt(light, "limit", 24),
      },
      deep: {
        ...readDreamingPhaseBase(deep),
        limit: readInt(deep, "limit", 12),
        minScore: readScore(deep, "minScore", 0.6),
        minRecallCount: readInt(deep, "minRecallCount", 2),
        minUniqueQueries: readInt(deep, "minUniqueQueries", 2),
        recencyHalfLifeDays: readInt(deep, "recencyHalfLifeDays", 30),
        ...(typeof deep.maxAgeDays === "number" && Number.isFinite(deep.maxAgeDays)
          ? { maxAgeDays: readInt(deep, "maxAgeDays", 0) }
          : {}),
      },
      rem: {
        ...readDreamingPhaseBase(rem),
        lookbackDays: readInt(rem, "lookbackDays", 14),
        limit: readInt(rem, "limit", 12),
        minPatternStrength: readScore(rem, "minPatternStrength", 0.6),
      },
    },
  };
}

function resolveMemoryAgentId(params: Record<string, unknown>, cfg: FasedAgentConfig): string {
  return optionalString(params.agentId) ?? resolveDefaultAgentId(cfg);
}

async function loadMemoryInventory(
  agentId: string,
  cfg: FasedAgentConfig,
): Promise<DoctorMemoryInventoryPayload> {
  let providerStatus: MemoryProviderStatus | undefined;
  let providerError: string | undefined;
  const { manager, error } = await getMemorySearchManager({
    cfg,
    agentId,
    purpose: "status",
  });
  providerError = error;

  if (manager) {
    try {
      providerStatus = manager.status();
    } catch (err) {
      providerError = `memory status failed: ${formatError(err)}`;
    } finally {
      await manager.close?.().catch(() => {});
    }
  }

  return await buildMemoryInventory({
    cfg,
    agentId,
    ...(providerStatus ? { providerStatus } : {}),
    ...(providerError ? { providerError } : {}),
  });
}
