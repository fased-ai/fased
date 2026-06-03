import { sanitizeAgentId } from "../routing/session-key.js";
import { isRecord } from "../utils.js";
import {
  buildDeliveryFromLegacyPayload,
  hasLegacyDeliveryHints,
  stripLegacyDeliveryFields,
} from "./legacy-delivery.js";
import { parseAbsoluteTimeMs } from "./parse.js";
import { migrateLegacyCronPayload } from "./payload-migration.js";
import { inferLegacyName } from "./service/normalize.js";
import { normalizeCronStaggerMs, resolveDefaultCronStaggerMs } from "./stagger.js";
import type { CronJobCreate, CronJobPatch } from "./types.js";

type UnknownRecord = Record<string, unknown>;

type NormalizeOptions = {
  applyDefaults?: boolean;
};

const DEFAULT_OPTIONS: NormalizeOptions = {
  applyDefaults: false,
};

function coerceSchedule(schedule: UnknownRecord) {
  const next: UnknownRecord = { ...schedule };
  const rawKind = typeof schedule.kind === "string" ? schedule.kind.trim().toLowerCase() : "";
  const kind = rawKind === "at" || rawKind === "every" || rawKind === "cron" ? rawKind : undefined;
  const atMsRaw = schedule.atMs;
  const atRaw = schedule.at;
  const atString = typeof atRaw === "string" ? atRaw.trim() : "";
  const parsedAtMs =
    typeof atMsRaw === "number"
      ? atMsRaw
      : typeof atMsRaw === "string"
        ? parseAbsoluteTimeMs(atMsRaw)
        : atString
          ? parseAbsoluteTimeMs(atString)
          : null;

  if (kind) {
    next.kind = kind;
  } else {
    if (
      typeof schedule.atMs === "number" ||
      typeof schedule.at === "string" ||
      typeof schedule.atMs === "string"
    ) {
      next.kind = "at";
    } else if (typeof schedule.everyMs === "number") {
      next.kind = "every";
    } else if (typeof schedule.expr === "string") {
      next.kind = "cron";
    }
  }

  if (atString) {
    next.at = parsedAtMs !== null ? new Date(parsedAtMs).toISOString() : atString;
  } else if (parsedAtMs !== null) {
    next.at = new Date(parsedAtMs).toISOString();
  }
  if ("atMs" in next) {
    delete next.atMs;
  }

  const staggerMs = normalizeCronStaggerMs(schedule.staggerMs);
  if (staggerMs !== undefined) {
    next.staggerMs = staggerMs;
  } else if ("staggerMs" in next) {
    delete next.staggerMs;
  }

  return next;
}

function coercePayload(payload: UnknownRecord) {
  const next: UnknownRecord = { ...payload };
  // Back-compat: older configs used `provider` for delivery channel.
  migrateLegacyCronPayload(next);
  const kindRaw = typeof next.kind === "string" ? next.kind.trim().toLowerCase() : "";
  if (kindRaw === "agentturn") {
    next.kind = "agentTurn";
  } else if (kindRaw === "systemevent") {
    next.kind = "systemEvent";
  } else if (kindRaw) {
    next.kind = kindRaw;
  }
  if (!next.kind) {
    const hasMessage = typeof next.message === "string" && next.message.trim().length > 0;
    const hasText = typeof next.text === "string" && next.text.trim().length > 0;
    const hasAgentTurnHint =
      typeof next.model === "string" ||
      typeof next.thinking === "string" ||
      typeof next.timeoutSeconds === "number" ||
      typeof next.allowUnsafeExternalContent === "boolean";
    if (hasMessage) {
      next.kind = "agentTurn";
    } else if (hasText) {
      next.kind = "systemEvent";
    } else if (hasAgentTurnHint) {
      // Accept partial agentTurn payload patches that only tweak agent-turn-only fields.
      next.kind = "agentTurn";
    }
  }
  if (typeof next.message === "string") {
    const trimmed = next.message.trim();
    if (trimmed) {
      next.message = trimmed;
    }
  }
  if (typeof next.text === "string") {
    const trimmed = next.text.trim();
    if (trimmed) {
      next.text = trimmed;
    }
  }
  if ("model" in next) {
    if (typeof next.model === "string") {
      const trimmed = next.model.trim();
      if (trimmed) {
        next.model = trimmed;
      } else {
        delete next.model;
      }
    } else {
      delete next.model;
    }
  }
  if ("thinking" in next) {
    if (typeof next.thinking === "string") {
      const trimmed = next.thinking.trim();
      if (trimmed) {
        next.thinking = trimmed;
      } else {
        delete next.thinking;
      }
    } else {
      delete next.thinking;
    }
  }
  if ("timeoutSeconds" in next) {
    if (typeof next.timeoutSeconds === "number" && Number.isFinite(next.timeoutSeconds)) {
      next.timeoutSeconds = Math.max(0, Math.floor(next.timeoutSeconds));
    } else {
      delete next.timeoutSeconds;
    }
  }
  if ("lightContext" in next && typeof next.lightContext !== "boolean") {
    delete next.lightContext;
  }
  if (
    "allowUnsafeExternalContent" in next &&
    typeof next.allowUnsafeExternalContent !== "boolean"
  ) {
    delete next.allowUnsafeExternalContent;
  }
  return next;
}

function coerceDelivery(delivery: UnknownRecord) {
  const next: UnknownRecord = { ...delivery };
  if (typeof delivery.mode === "string") {
    const mode = delivery.mode.trim().toLowerCase();
    if (mode === "deliver") {
      next.mode = "announce";
    } else if (mode === "announce" || mode === "none" || mode === "webhook") {
      next.mode = mode;
    } else {
      delete next.mode;
    }
  } else if ("mode" in next) {
    delete next.mode;
  }
  if (typeof delivery.channel === "string") {
    const trimmed = delivery.channel.trim().toLowerCase();
    if (trimmed) {
      next.channel = trimmed;
    } else {
      delete next.channel;
    }
  }
  if (typeof delivery.to === "string") {
    const trimmed = delivery.to.trim();
    if (trimmed) {
      next.to = trimmed;
    } else {
      delete next.to;
    }
  }
  return next;
}

function coerceEnum<T extends string>(raw: unknown, allowed: readonly T[]): T | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim().toLowerCase();
  return allowed.includes(trimmed as T) ? (trimmed as T) : undefined;
}

function coerceNonNegativeNumber(raw: unknown) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return undefined;
  }
  return raw;
}

function coercePositiveInteger(raw: unknown) {
  const value = coerceNonNegativeNumber(raw);
  if (value === undefined || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function coerceTrimmedString(raw: unknown) {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function coerceFailureAlert(raw: unknown) {
  if (raw === false) {
    return false as const;
  }
  if (!isRecord(raw)) {
    return undefined;
  }

  const next: UnknownRecord = {};
  const after = coercePositiveInteger(raw.after);
  if (after !== undefined) {
    next.after = after;
  }
  const channel = coerceTrimmedString(raw.channel);
  if (channel) {
    next.channel = channel;
  }
  const to = coerceTrimmedString(raw.to);
  if (to) {
    next.to = to;
  }
  const cooldownMs = coerceNonNegativeNumber(raw.cooldownMs);
  if (cooldownMs !== undefined) {
    next.cooldownMs = Math.floor(cooldownMs);
  }
  const mode = coerceEnum(raw.mode, ["announce", "webhook"] as const);
  if (mode) {
    next.mode = mode;
  }
  const accountId = coerceTrimmedString(raw.accountId);
  if (accountId) {
    next.accountId = accountId;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function coerceStringList(raw: unknown) {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const values = Array.from(
    new Set(
      raw
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
  return values.length > 0 ? values : undefined;
}

function coerceWorkflowSubsteps(raw: unknown) {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const substeps = raw
    .filter((entry): entry is UnknownRecord => isRecord(entry))
    .map((entry) => {
      const id = coerceEnum(entry.id, [
        "plan-analysis",
        "execute-tool-or-model",
        "synthesize",
      ] as const);
      const label = coerceTrimmedString(entry.label);
      if (!id || !label) {
        return undefined;
      }
      const substep: UnknownRecord = { id, label };
      const description = coerceTrimmedString(entry.description);
      if (description) {
        substep.description = description;
      }
      if (typeof entry.usesModel === "boolean") {
        substep.usesModel = entry.usesModel;
      }
      if (typeof entry.usesTool === "boolean") {
        substep.usesTool = entry.usesTool;
      }
      if (typeof entry.retryable === "boolean") {
        substep.retryable = entry.retryable;
      }
      const checkpointKeys = coerceStringList(entry.checkpointKeys);
      if (checkpointKeys) {
        substep.checkpointKeys = checkpointKeys;
      }
      return substep;
    })
    .filter((entry): entry is UnknownRecord => Boolean(entry));
  return substeps.length > 0 ? substeps : undefined;
}

function coerceWorkflowGraph(raw: unknown) {
  if (!isRecord(raw)) {
    return undefined;
  }
  const entryNodeId = coerceTrimmedString(raw.entryNodeId);
  const terminalNodeIds = coerceStringList(raw.terminalNodeIds);
  if (!entryNodeId || !terminalNodeIds) {
    return undefined;
  }
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes
        .filter((entry): entry is UnknownRecord => isRecord(entry))
        .map((entry) => {
          const id = coerceTrimmedString(entry.id);
          const label = coerceTrimmedString(entry.label);
          const kind = coerceEnum(entry.kind, [
            "collect",
            "tool",
            "model",
            "coordination",
            "validation",
            "synthesize",
            "deliver",
          ] as const);
          if (!id || !label || !kind) {
            return undefined;
          }
          const node: UnknownRecord = { id, label, kind };
          const description = coerceTrimmedString(entry.description);
          if (description) {
            node.description = description;
          }
          const dependsOn = coerceStringList(entry.dependsOn);
          if (dependsOn) {
            node.dependsOn = dependsOn;
          }
          if (typeof entry.usesModel === "boolean") {
            node.usesModel = entry.usesModel;
          }
          if (typeof entry.usesTool === "boolean") {
            node.usesTool = entry.usesTool;
          }
          if (typeof entry.retryable === "boolean") {
            node.retryable = entry.retryable;
          }
          const checkpointKeys = coerceStringList(entry.checkpointKeys);
          if (checkpointKeys) {
            node.checkpointKeys = checkpointKeys;
          }
          return node;
        })
        .filter((entry): entry is UnknownRecord => Boolean(entry))
    : [];
  if (nodes.length === 0) {
    return undefined;
  }
  const next: UnknownRecord = { version: 1, entryNodeId, terminalNodeIds, nodes };
  for (const key of ["graphRevision", "parentRevision", "repairRevision"]) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      next[key] = Math.floor(value);
    }
  }
  return next;
}

function coerceExecutionPolicy(policy: UnknownRecord) {
  const next: UnknownRecord = {};
  const objective = coerceTrimmedString(policy.objective);
  if (objective) {
    next.objective = objective;
  }
  const successCriteria = coerceTrimmedString(policy.successCriteria);
  if (successCriteria) {
    next.successCriteria = successCriteria;
  }
  const triggerKind = coerceEnum(policy.triggerKind, [
    "schedule",
    "heartbeat",
    "webhook",
    "channel",
    "manual",
    "event",
  ] as const);
  if (triggerKind) {
    next.triggerKind = triggerKind;
  }
  const executionMode = coerceEnum(policy.executionMode, [
    "auto",
    "agent-turn",
    "skill-only",
    "no-model",
  ] as const);
  if (executionMode) {
    next.executionMode = executionMode;
  }
  const memoryScope = coerceEnum(policy.memoryScope, [
    "none",
    "session-summary",
    "pinned",
    "search",
    "agent",
  ] as const);
  if (memoryScope) {
    next.memoryScope = memoryScope;
  }
  const skillScope = coerceEnum(policy.skillScope, ["none", "selected", "agent-default"] as const);
  if (skillScope) {
    next.skillScope = skillScope;
  }
  if (Array.isArray(policy.allowedSkills)) {
    const allowedSkills = Array.from(
      new Set(
        policy.allowedSkills
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    );
    if (allowedSkills.length > 0) {
      next.allowedSkills = allowedSkills;
    }
  }
  if (isRecord(policy.skillAction)) {
    const toolName =
      typeof policy.skillAction.toolName === "string" ? policy.skillAction.toolName.trim() : "";
    if (toolName) {
      const skillAction: UnknownRecord = { toolName };
      if (isRecord(policy.skillAction.input)) {
        skillAction.input = { ...policy.skillAction.input };
      }
      next.skillAction = skillAction;
    }
  }
  if (isRecord(policy.modelPolicy)) {
    const modelPolicy: UnknownRecord = {};
    const mode = coerceEnum(policy.modelPolicy.mode, [
      "agent-default",
      "task-override",
      "auto",
      "none",
    ] as const);
    if (mode) {
      modelPolicy.mode = mode;
    }
    for (const field of ["model", "thinking", "escalationModel"] as const) {
      const value = policy.modelPolicy[field];
      if (typeof value === "string" && value.trim()) {
        modelPolicy[field] = value.trim();
      }
    }
    if (Object.keys(modelPolicy).length > 0) {
      next.modelPolicy = modelPolicy;
    }
  }
  if (isRecord(policy.coordination)) {
    const coordination: UnknownRecord = {};
    const mode = coerceEnum(policy.coordination.mode, ["none", "consult", "parallel"] as const);
    if (mode) {
      coordination.mode = mode;
    }
    if (Array.isArray(policy.coordination.agents)) {
      const agents = Array.from(
        new Set(
          policy.coordination.agents
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      );
      if (agents.length > 0) {
        coordination.agents = agents;
      }
    }
    const maxAgents = coercePositiveInteger(policy.coordination.maxAgents);
    if (maxAgents !== undefined) {
      coordination.maxAgents = maxAgents;
    }
    const maxRounds = coercePositiveInteger(policy.coordination.maxRounds);
    if (maxRounds !== undefined) {
      coordination.maxRounds = maxRounds;
    }
    if (typeof policy.coordination.requireApproval === "boolean") {
      coordination.requireApproval = policy.coordination.requireApproval;
    }
    if (typeof policy.coordination.stopWhenAdvisorsAgree === "boolean") {
      coordination.stopWhenAdvisorsAgree = policy.coordination.stopWhenAdvisorsAgree;
    }
    if (typeof policy.coordination.escalateWhenAdvisorsConflict === "boolean") {
      coordination.escalateWhenAdvisorsConflict = policy.coordination.escalateWhenAdvisorsConflict;
    }
    if (Object.keys(coordination).length > 0) {
      next.coordination = coordination;
    }
  }
  if (isRecord(policy.budget)) {
    const budget: UnknownRecord = {};
    for (const field of ["maxTokensPerRun", "maxCostUsdPerRun", "maxRunsPerHour"] as const) {
      const value = coerceNonNegativeNumber(policy.budget[field]);
      if (value !== undefined) {
        budget[field] = value;
      }
    }
    if (Object.keys(budget).length > 0) {
      next.budget = budget;
    }
  }
  if (isRecord(policy.stop)) {
    const stop: UnknownRecord = {};
    if (typeof policy.stop.onSuccess === "boolean") {
      stop.onSuccess = policy.stop.onSuccess;
    }
    if (Array.isArray(policy.stop.outputIncludes)) {
      const outputIncludes = Array.from(
        new Set(
          policy.stop.outputIncludes
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      );
      if (outputIncludes.length > 0) {
        stop.outputIncludes = outputIncludes;
      }
    }
    const maxSuccessfulRuns = coercePositiveInteger(policy.stop.maxSuccessfulRuns);
    if (maxSuccessfulRuns !== undefined) {
      stop.maxSuccessfulRuns = maxSuccessfulRuns;
    }
    const maxTotalRuns = coercePositiveInteger(policy.stop.maxTotalRuns);
    if (maxTotalRuns !== undefined) {
      stop.maxTotalRuns = maxTotalRuns;
    }
    if (Object.keys(stop).length > 0) {
      next.stop = stop;
    }
  }
  if (isRecord(policy.evaluator)) {
    const evaluator: UnknownRecord = {};
    if (typeof policy.evaluator.escalateOnSignal === "boolean") {
      evaluator.escalateOnSignal = policy.evaluator.escalateOnSignal;
    }
    if (Array.isArray(policy.evaluator.signalIncludes)) {
      const signalIncludes = Array.from(
        new Set(
          policy.evaluator.signalIncludes
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      );
      if (signalIncludes.length > 0) {
        evaluator.signalIncludes = signalIncludes;
      }
    }
    const maxEscalations = coercePositiveInteger(policy.evaluator.maxEscalations);
    if (maxEscalations !== undefined) {
      evaluator.maxEscalations = maxEscalations;
    }
    if (Object.keys(evaluator).length > 0) {
      next.evaluator = evaluator;
    }
  }
  if (isRecord(policy.repairPolicy)) {
    const repairPolicy: UnknownRecord = {};
    if (typeof policy.repairPolicy.autoRetryReplacement === "boolean") {
      repairPolicy.autoRetryReplacement = policy.repairPolicy.autoRetryReplacement;
    }
    if (typeof policy.repairPolicy.autoStopOptionalSources === "boolean") {
      repairPolicy.autoStopOptionalSources = policy.repairPolicy.autoStopOptionalSources;
    }
    const maxAutoRepairsPerRun = coercePositiveInteger(policy.repairPolicy.maxAutoRepairsPerRun);
    if (maxAutoRepairsPerRun !== undefined) {
      repairPolicy.maxAutoRepairsPerRun = maxAutoRepairsPerRun;
    }
    if (typeof policy.repairPolicy.requireApprovalForPrimarySource === "boolean") {
      repairPolicy.requireApprovalForPrimarySource =
        policy.repairPolicy.requireApprovalForPrimarySource;
    }
    if (Object.keys(repairPolicy).length > 0) {
      next.repairPolicy = repairPolicy;
    }
  }
  if (isRecord(policy.planner)) {
    const strategy = coerceEnum(policy.planner.strategy, [
      "agent-default",
      "cheap-model",
      "strong-model",
      "skill-only",
      "no-model",
    ] as const);
    const rationale = coerceTrimmedString(policy.planner.rationale);
    if (strategy && rationale) {
      const planner: UnknownRecord = {
        source: "heuristic",
        strategy,
        rationale,
      };
      const confidence = coerceEnum(policy.planner.confidence, ["low", "medium", "high"] as const);
      if (confidence) {
        planner.confidence = confidence;
      }
      if (Array.isArray(policy.planner.signals)) {
        const signals = Array.from(
          new Set(
            policy.planner.signals
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean),
          ),
        );
        if (signals.length > 0) {
          planner.signals = signals;
        }
      }
      if (Array.isArray(policy.planner.steps)) {
        const steps = policy.planner.steps
          .filter((entry): entry is UnknownRecord => isRecord(entry))
          .map((entry) => {
            const id = coerceEnum(entry.id, ["collect", "analyze", "evaluate", "deliver"] as const);
            const label = coerceTrimmedString(entry.label);
            if (!id || !label) {
              return undefined;
            }
            const step: UnknownRecord = { id, label };
            const description = coerceTrimmedString(entry.description);
            if (description) {
              step.description = description;
            }
            if (typeof entry.usesModel === "boolean") {
              step.usesModel = entry.usesModel;
            }
            if (typeof entry.usesTool === "boolean") {
              step.usesTool = entry.usesTool;
            }
            if (typeof entry.retryable === "boolean") {
              step.retryable = entry.retryable;
            }
            const checkpointKeys = coerceStringList(entry.checkpointKeys);
            if (checkpointKeys) {
              step.checkpointKeys = checkpointKeys;
            }
            const substeps = coerceWorkflowSubsteps(entry.substeps);
            if (substeps) {
              step.substeps = substeps;
            }
            return step;
          })
          .filter((entry): entry is UnknownRecord => Boolean(entry));
        if (steps.length > 0) {
          planner.steps = steps;
        }
      }
      const graph = coerceWorkflowGraph(policy.planner.graph);
      if (graph) {
        planner.graph = graph;
      }
      next.planner = planner;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function unwrapJob(raw: UnknownRecord) {
  if (isRecord(raw.data)) {
    return raw.data;
  }
  if (isRecord(raw.job)) {
    return raw.job;
  }
  return raw;
}

function normalizeSessionTarget(raw: unknown) {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "main" || trimmed === "isolated") {
    return trimmed;
  }
  return undefined;
}

function normalizeWakeMode(raw: unknown) {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "now" || trimmed === "next-heartbeat") {
    return trimmed;
  }
  return undefined;
}

function copyTopLevelAgentTurnFields(next: UnknownRecord, payload: UnknownRecord) {
  const copyString = (field: "model" | "thinking") => {
    if (typeof payload[field] === "string" && payload[field].trim()) {
      return;
    }
    const value = next[field];
    if (typeof value === "string" && value.trim()) {
      payload[field] = value.trim();
    }
  };
  copyString("model");
  copyString("thinking");

  if (typeof payload.timeoutSeconds !== "number" && typeof next.timeoutSeconds === "number") {
    payload.timeoutSeconds = next.timeoutSeconds;
  }
  if (typeof payload.lightContext !== "boolean" && typeof next.lightContext === "boolean") {
    payload.lightContext = next.lightContext;
  }
  if (
    typeof payload.allowUnsafeExternalContent !== "boolean" &&
    typeof next.allowUnsafeExternalContent === "boolean"
  ) {
    payload.allowUnsafeExternalContent = next.allowUnsafeExternalContent;
  }
}

function copyTopLevelLegacyDeliveryFields(next: UnknownRecord, payload: UnknownRecord) {
  if (typeof payload.deliver !== "boolean" && typeof next.deliver === "boolean") {
    payload.deliver = next.deliver;
  }
  if (
    typeof payload.channel !== "string" &&
    typeof next.channel === "string" &&
    next.channel.trim()
  ) {
    payload.channel = next.channel.trim();
  }
  if (typeof payload.to !== "string" && typeof next.to === "string" && next.to.trim()) {
    payload.to = next.to.trim();
  }
  if (
    typeof payload.bestEffortDeliver !== "boolean" &&
    typeof next.bestEffortDeliver === "boolean"
  ) {
    payload.bestEffortDeliver = next.bestEffortDeliver;
  }
  if (
    typeof payload.provider !== "string" &&
    typeof next.provider === "string" &&
    next.provider.trim()
  ) {
    payload.provider = next.provider.trim();
  }
}

function stripLegacyTopLevelFields(next: UnknownRecord) {
  delete next.model;
  delete next.thinking;
  delete next.timeoutSeconds;
  delete next.lightContext;
  delete next.allowUnsafeExternalContent;
  delete next.message;
  delete next.text;
  delete next.deliver;
  delete next.channel;
  delete next.to;
  delete next.bestEffortDeliver;
  delete next.provider;
}

export function normalizeCronJobInput(
  raw: unknown,
  options: NormalizeOptions = DEFAULT_OPTIONS,
): UnknownRecord | null {
  if (!isRecord(raw)) {
    return null;
  }
  const base = unwrapJob(raw);
  const next: UnknownRecord = { ...base };

  if ("agentId" in base) {
    const agentId = base.agentId;
    if (agentId === null) {
      next.agentId = null;
    } else if (typeof agentId === "string") {
      const trimmed = agentId.trim();
      if (trimmed) {
        next.agentId = sanitizeAgentId(trimmed);
      } else {
        delete next.agentId;
      }
    }
  }

  if ("sessionKey" in base) {
    const sessionKey = base.sessionKey;
    if (sessionKey === null) {
      next.sessionKey = null;
    } else if (typeof sessionKey === "string") {
      const trimmed = sessionKey.trim();
      if (trimmed) {
        next.sessionKey = trimmed;
      } else {
        delete next.sessionKey;
      }
    }
  }

  if ("enabled" in base) {
    const enabled = base.enabled;
    if (typeof enabled === "boolean") {
      next.enabled = enabled;
    } else if (typeof enabled === "string") {
      const trimmed = enabled.trim().toLowerCase();
      if (trimmed === "true") {
        next.enabled = true;
      }
      if (trimmed === "false") {
        next.enabled = false;
      }
    }
  }

  if ("sessionTarget" in base) {
    const normalized = normalizeSessionTarget(base.sessionTarget);
    if (normalized) {
      next.sessionTarget = normalized;
    } else {
      delete next.sessionTarget;
    }
  }

  if ("wakeMode" in base) {
    const normalized = normalizeWakeMode(base.wakeMode);
    if (normalized) {
      next.wakeMode = normalized;
    } else {
      delete next.wakeMode;
    }
  }

  if (isRecord(base.schedule)) {
    next.schedule = coerceSchedule(base.schedule);
  }

  if (!("payload" in next) || !isRecord(next.payload)) {
    const message = typeof next.message === "string" ? next.message.trim() : "";
    const text = typeof next.text === "string" ? next.text.trim() : "";
    if (message) {
      next.payload = { kind: "agentTurn", message };
    } else if (text) {
      next.payload = { kind: "systemEvent", text };
    }
  }

  if (isRecord(base.payload)) {
    next.payload = coercePayload(base.payload);
  }

  if (isRecord(base.delivery)) {
    next.delivery = coerceDelivery(base.delivery);
  }

  if ("failureAlert" in base) {
    const failureAlert = coerceFailureAlert(base.failureAlert);
    if (failureAlert !== undefined) {
      next.failureAlert = failureAlert;
    } else {
      delete next.failureAlert;
    }
  }

  if ("executionPolicy" in base) {
    if (base.executionPolicy === null) {
      next.executionPolicy = null;
    } else if (isRecord(base.executionPolicy)) {
      const executionPolicy = coerceExecutionPolicy(base.executionPolicy);
      if (executionPolicy) {
        next.executionPolicy = executionPolicy;
      } else {
        delete next.executionPolicy;
      }
    } else {
      delete next.executionPolicy;
    }
  }

  if ("isolation" in next) {
    delete next.isolation;
  }

  const payload = isRecord(next.payload) ? next.payload : null;
  if (payload && payload.kind === "agentTurn") {
    copyTopLevelAgentTurnFields(next, payload);
    copyTopLevelLegacyDeliveryFields(next, payload);
  }
  stripLegacyTopLevelFields(next);

  if (options.applyDefaults) {
    if (!next.wakeMode) {
      next.wakeMode = "now";
    }
    if (typeof next.enabled !== "boolean") {
      next.enabled = true;
    }
    if (
      (typeof next.name !== "string" || !next.name.trim()) &&
      isRecord(next.schedule) &&
      isRecord(next.payload)
    ) {
      next.name = inferLegacyName({
        schedule: next.schedule as { kind?: unknown; everyMs?: unknown; expr?: unknown },
        payload: next.payload as { kind?: unknown; text?: unknown; message?: unknown },
      });
    } else if (typeof next.name === "string") {
      const trimmed = next.name.trim();
      if (trimmed) {
        next.name = trimmed;
      }
    }
    if (!next.sessionTarget && isRecord(next.payload)) {
      const kind = typeof next.payload.kind === "string" ? next.payload.kind : "";
      if (kind === "systemEvent") {
        next.sessionTarget = "main";
      }
      if (kind === "agentTurn") {
        next.sessionTarget = "isolated";
      }
    }
    if (
      "schedule" in next &&
      isRecord(next.schedule) &&
      next.schedule.kind === "at" &&
      !("deleteAfterRun" in next)
    ) {
      next.deleteAfterRun = true;
    }
    if ("schedule" in next && isRecord(next.schedule) && next.schedule.kind === "cron") {
      const schedule = next.schedule as UnknownRecord;
      const explicit = normalizeCronStaggerMs(schedule.staggerMs);
      if (explicit !== undefined) {
        schedule.staggerMs = explicit;
      } else {
        const expr = typeof schedule.expr === "string" ? schedule.expr : "";
        const defaultStaggerMs = resolveDefaultCronStaggerMs(expr);
        if (defaultStaggerMs !== undefined) {
          schedule.staggerMs = defaultStaggerMs;
        }
      }
    }
    const payload = isRecord(next.payload) ? next.payload : null;
    const payloadKind = payload && typeof payload.kind === "string" ? payload.kind : "";
    const sessionTarget = typeof next.sessionTarget === "string" ? next.sessionTarget : "";
    const isIsolatedAgentTurn =
      sessionTarget === "isolated" || (sessionTarget === "" && payloadKind === "agentTurn");
    const hasDelivery = "delivery" in next && next.delivery !== undefined;
    const hasLegacyDelivery = payload ? hasLegacyDeliveryHints(payload) : false;
    if (!hasDelivery && isIsolatedAgentTurn && payloadKind === "agentTurn") {
      if (payload && hasLegacyDelivery) {
        next.delivery = buildDeliveryFromLegacyPayload(payload);
        stripLegacyDeliveryFields(payload);
      } else {
        next.delivery = { mode: "announce" };
      }
    }
  }

  return next;
}

export function normalizeCronJobCreate(
  raw: unknown,
  options?: NormalizeOptions,
): CronJobCreate | null {
  return normalizeCronJobInput(raw, {
    applyDefaults: true,
    ...options,
  }) as CronJobCreate | null;
}

export function normalizeCronJobPatch(
  raw: unknown,
  options?: NormalizeOptions,
): CronJobPatch | null {
  return normalizeCronJobInput(raw, {
    applyDefaults: false,
    ...options,
  }) as CronJobPatch | null;
}
