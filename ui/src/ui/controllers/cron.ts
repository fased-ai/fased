import { t } from "../../i18n/index.ts";
import { DEFAULT_CRON_FORM } from "../app-defaults.ts";
import { toNumber } from "../format.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  CronJob,
  CronDelivery,
  CronDeliveryStatus,
  CronJobsEnabledFilter,
  CronJobsListResult,
  CronJobsSortBy,
  CronRunScope,
  CronRunLogEntry,
  CronRunsResult,
  CronRunsStatusFilter,
  CronRunsStatusValue,
  CronSchedule,
  CronSortDir,
  CronStatus,
  CronTaskExecutionPolicy,
  CronTaskAdaptiveRoute,
  CronTaskRunDetail,
} from "../types.ts";
import { CRON_CHANNEL_LAST } from "../ui-types.ts";
import type { CronFormState } from "../ui-types.ts";
import { loadModels } from "./models.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

export type CronFieldKey =
  | "name"
  | "scheduleAt"
  | "everyAmount"
  | "cronExpr"
  | "staggerAmount"
  | "payloadText"
  | "payloadModel"
  | "payloadThinking"
  | "timeoutSeconds"
  | "deliveryTo"
  | "failureAlertAfter"
  | "failureAlertCooldownSeconds";

export type CronFieldErrors = Partial<Record<CronFieldKey, string>>;

export type CronJobsScheduleKindFilter = "all" | "at" | "every" | "cron";
export type CronJobsLastStatusFilter = "all" | "ok" | "error" | "skipped" | "blocked";
export type CronJobsAdaptiveRouteFilter = "all" | CronTaskAdaptiveRoute;
export type CronRepairAction =
  | "configure_source"
  | "add_trusted_source"
  | "retry_replacement"
  | "stop_source_path";

export type ChatScheduleKind = "every" | "at" | "cron";
export type ChatScheduleEveryUnit = "minutes" | "hours" | "days";
export type ChatScheduleDeliveryMode = "local" | "channel";

export type ChatScheduleDraft = {
  open: boolean;
  editingJobId: string | null;
  agentId: string;
  name: string;
  prompt: string;
  objective: string;
  successCriteria: string;
  kind: ChatScheduleKind;
  everyAmount: string;
  everyUnit: ChatScheduleEveryUnit;
  at: string;
  cronExpr: string;
  deliveryMode: ChatScheduleDeliveryMode;
  executionMode: "auto" | "agent-turn" | "skill-only" | "no-model";
  memoryScope: "none" | "session-summary" | "pinned" | "search" | "agent";
  skillScope: "none" | "selected" | "agent-default";
  allowedSkills: string;
  skillToolName: string;
  skillToolInputJson: string;
  plannerStrategy: "" | "cheap-model" | "strong-model";
  modelRole: "" | "cheapCheck" | "strong" | "escalation" | "coding" | "summarizer";
  policyModel: string;
  escalationModel: string;
  coordinationMode: "none" | "consult" | "parallel";
  coordinationAgents: string;
  coordinationMaxAgents: string;
  coordinationRequireApproval: boolean;
  evaluatorEscalateOnSignal: boolean;
  evaluatorSignalIncludes: string;
  evaluatorMaxEscalations: string;
  repairAutoRetryReplacement: boolean;
  repairAutoStopOptionalSources: boolean;
  repairMaxAutoRepairsPerRun: string;
  repairRequireApprovalForPrimarySource: boolean;
  budgetMaxTokensPerRun: string;
  budgetMaxCostUsdPerRun: string;
  budgetMaxRunsPerHour: string;
  stopOnSuccess: boolean;
  stopTextIncludes: string;
  stopMaxSuccessfulRuns: string;
  stopMaxTotalRuns: string;
  error: string | null;
};

export type TaskPolicyPreset =
  | "auto"
  | "cheap-check"
  | "strong-model"
  | "skill-only"
  | "no-model"
  | "stop-success";

export const TASK_POLICY_PRESET_OPTIONS: Array<{ id: TaskPolicyPreset; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "cheap-check", label: "Cheap check" },
  { id: "strong-model", label: "Strong model" },
  { id: "skill-only", label: "Skill-only" },
  { id: "no-model", label: "No model" },
  { id: "stop-success", label: "Stop on success" },
];

export type TaskTemplatePreset =
  | "aom-strategy"
  | "mining-status"
  | "aom-strategy-ab"
  | "wallet-reserve-watch"
  | "staking-rewards-watch"
  | "provider-health-check"
  | "marketplace-order-followup"
  | "rpc-pressure-report";

export const TASK_TEMPLATE_PRESET_OPTIONS: Array<{
  id: TaskTemplatePreset;
  label: string;
  description: string;
}> = [
  {
    id: "aom-strategy",
    label: "Mining strategy review",
    description:
      "Mining strategy-only task. Reads @mining, may change strategy, never changes capital.",
  },
  {
    id: "mining-status",
    label: "Mining status report",
    description: "Read-only mining health report for status, cycle, balances, capital, and claims.",
  },
  {
    id: "aom-strategy-ab",
    label: "Strategy A/B review",
    description:
      "Strategy-only comparison across balanced, top_k, ranked, crowd_aware, and adaptive.",
  },
  {
    id: "wallet-reserve-watch",
    label: "Wallet reserve watch",
    description: "Read-only wallet reserve alert for mining, agent, and vault balances.",
  },
  {
    id: "staking-rewards-watch",
    label: "Staking rewards watch",
    description: "Read-only Fased Network staking report for bond, claimable SAT, and reward pool.",
  },
  {
    id: "provider-health-check",
    label: "Provider health check",
    description: "Recurring provider, channel, tool, signer, and RPC health check.",
  },
  {
    id: "marketplace-order-followup",
    label: "Marketplace follow-up",
    description:
      "Checks open marketplace orders for stuck payment, delivery, receipt, or dispute state.",
  },
  {
    id: "rpc-pressure-report",
    label: "RPC pressure report",
    description: "Internal operator report for RPC call pressure, failover, and expensive labels.",
  },
];

const MINING_STRATEGY_TASK_PROMPT = `Every cycle, inspect @mining status/history only. You may change strategyPreset, strategyExecution, and strategyMode. Do not use wallet, payment, send, swap, bond, or web-search tools. Do not change active commit, target max, capital, funding, withdraw, claim mode, or sweep policy. Report old strategy, new strategy, reason, and whether active commit changed.`;

type TaskTemplatePatchDefinition = {
  name: string;
  description: string;
  everyAmount: string;
  everyUnit: CronFormState["everyUnit"];
  objective: string;
  success: string;
  allowedSkills: string;
  prompt: string;
  budgetMaxRunsPerHour?: string;
  memoryScope?: CronFormState["memoryScope"];
};

const TASK_TEMPLATE_PATCHES: Record<TaskTemplatePreset, TaskTemplatePatchDefinition> = {
  "aom-strategy": {
    name: "Mining strategy review",
    description: "Strategy-only SAT mining review with capital risk locked.",
    everyAmount: "30",
    everyUnit: "minutes",
    objective: "Improve mining strategy selection without changing capital risk.",
    success:
      "Report old strategy, new strategy, reason, and confirm active commit stayed unchanged.",
    allowedSkills: "mining",
    prompt: MINING_STRATEGY_TASK_PROMPT,
    budgetMaxRunsPerHour: "4",
  },
  "mining-status": {
    name: "Mining status report",
    description: "Read-only SAT mining health report.",
    everyAmount: "15",
    everyUnit: "minutes",
    objective: "Report live mining state without changing runtime or funds.",
    success:
      "Report running/stopped/clearing state, current cycle, wallet SOL/SAT, capital, locked, claimable, and blockers.",
    allowedSkills: "mining",
    prompt:
      "Inspect @mining status, readiness, current cycle, and recent history only. Do not mutate any mining, wallet, bond, funding, claim, sweep, or strategy state. Report status, current cycle, wallet SOL/SAT, miner capital, locked capital, claimable rewards, clearing/recovery state, and blockers.",
    budgetMaxRunsPerHour: "6",
  },
  "aom-strategy-ab": {
    name: "Strategy A/B review",
    description: "Strategy-only SAT mining comparison with active commit locked.",
    everyAmount: "1",
    everyUnit: "hours",
    objective: "Compare mining strategies while keeping capital risk unchanged.",
    success:
      "Compare balanced/top_k/ranked/crowd_aware/adaptive evidence, report the selected strategy and fallback reason, and confirm active commit stayed unchanged.",
    allowedSkills: "mining",
    prompt:
      "Inspect @mining status/history only. Compare recent evidence for balanced, top_k, ranked, crowd_aware, and adaptive. You may change strategyPreset, strategyExecution, and strategyMode only. Do not change active commit, target max, capital, funding, withdraw, claim mode, sweep policy, start/stop state, wallet sends, bond actions, or web-search sources. Report old strategy, new strategy, evidence, fallback reason, and whether active commit changed.",
    budgetMaxRunsPerHour: "2",
  },
  "wallet-reserve-watch": {
    name: "Wallet reserve watch",
    description: "Read-only reserve alert for Agent, Vault, and Mining wallets.",
    everyAmount: "30",
    everyUnit: "minutes",
    objective: "Detect low SOL reserves before wallet, mining, or federation actions fail.",
    success:
      "Report each wallet's SOL/SAT balances, reserve status, and any action needed; do not create transactions.",
    allowedSkills: "wallet,mining",
    prompt:
      "Read wallet and mining balances only. Check Agent, Vault, and Mining wallets for SOL fee reserve and relevant SAT balances. Do not create approvals, sends, swaps, funding, withdrawals, claims, bond actions, key-management changes, or mining control actions. Report low-reserve wallets and suggested manual top-up amount.",
    budgetMaxRunsPerHour: "4",
  },
  "staking-rewards-watch": {
    name: "Staking rewards watch",
    description: "Read-only Fased Network bond staking reward report.",
    everyAmount: "30",
    everyUnit: "minutes",
    objective: "Report staking reward state without claiming or changing bond state.",
    success:
      "Report bond amount, staking weight, claimable SAT, pending reward pool, vault balance, and eligibility.",
    allowedSkills: "mining,wallet",
    prompt:
      "Inspect Fased Network staking and wallet balances only. Do not top up, unlock, sync, claim, send, fund, withdraw, or change bond/mining settings. Report bond amount, staking weight, claimable SAT, pending reward pool, vault SAT/SOL balance, eligibility state, and whether a manual Claim button is available.",
    budgetMaxRunsPerHour: "4",
  },
  "provider-health-check": {
    name: "Provider health check",
    description: "Recurring model/provider/channel/tool/signer/RPC health report.",
    everyAmount: "1",
    everyUnit: "hours",
    objective: "Catch provider, channel, tool, signer, and RPC readiness issues early.",
    success:
      "Report unhealthy providers, disconnected channels, missing tools, signer readiness, RPC failover state, and next manual fix.",
    allowedSkills: "providers,status",
    prompt:
      "Check provider, model, channel, tool, signer, and RPC readiness. Do not change config, install tools, rotate keys, send wallet transactions, or start/stop mining. Report unhealthy components, last known error, and recommended manual fix.",
    budgetMaxRunsPerHour: "2",
    memoryScope: "session-summary",
  },
  "marketplace-order-followup": {
    name: "Marketplace order follow-up",
    description: "Read-only follow-up for open marketplace order state.",
    everyAmount: "1",
    everyUnit: "hours",
    objective: "Find stuck marketplace payment, delivery, receipt, or dispute states.",
    success:
      "Report open/stuck orders, missing payment/delivery/receipt/dispute steps, and next manual action.",
    allowedSkills: "marketplace",
    prompt:
      "Inspect marketplace requests and orders only. Do not pay, refund, deliver, accept receipts, open disputes, send wallet transactions, or change listings. Report stuck payment, delivery, receipt, and dispute states with next manual action.",
    budgetMaxRunsPerHour: "2",
    memoryScope: "session-summary",
  },
  "rpc-pressure-report": {
    name: "RPC pressure report",
    description: "Internal operator report for expensive RPC labels and failover state.",
    everyAmount: "1",
    everyUnit: "hours",
    objective: "Track RPC pressure and identify expensive labels before costs climb.",
    success:
      "Report total calls, getAccountInfo count, expensive labels, failover status, and reduction target.",
    allowedSkills: "mining,status",
    prompt:
      "Inspect local runtime RPC metrics only. Do not mutate mining, wallet, bond, or config state. Report total RPC calls, getAccountInfo calls, highest labels, active/settlement/claim/cleanup phase if visible, failover state, and the next reduction target.",
    budgetMaxRunsPerHour: "2",
  },
};

export function buildCronTaskTemplatePatch(template: TaskTemplatePreset): Partial<CronFormState> {
  const definition = TASK_TEMPLATE_PATCHES[template];
  return {
    name: definition.name,
    description: definition.description,
    enabled: true,
    deleteAfterRun: false,
    scheduleKind: "every",
    everyAmount: definition.everyAmount,
    everyUnit: definition.everyUnit,
    sessionTarget: "isolated",
    taskObjective: definition.objective,
    taskSuccessCriteria: definition.success,
    executionMode: "auto",
    memoryScope: definition.memoryScope ?? "none",
    skillScope: "selected",
    allowedSkills: definition.allowedSkills,
    skillToolName: "",
    skillToolInputJson: "",
    plannerStrategy: "",
    modelRole: "",
    policyModel: "",
    escalationModel: "",
    coordinationMode: "none",
    coordinationAgents: "",
    coordinationMaxAgents: "",
    coordinationRequireApproval: true,
    evaluatorEscalateOnSignal: false,
    budgetMaxRunsPerHour: definition.budgetMaxRunsPerHour ?? "",
    stopOnSuccess: false,
    stopTextIncludes: "",
    stopMaxSuccessfulRuns: "",
    stopMaxTotalRuns: "",
    payloadKind: "agentTurn",
    payloadText: definition.prompt,
    payloadModel: "",
    payloadThinking: "",
    payloadLightContext: false,
    deliveryMode: "none",
    deliveryTo: "",
    deliveryChannel: "last",
    deliveryAccountId: "",
  };
}

type TaskPolicyPresetPatch = Partial<
  Pick<
    ChatScheduleDraft,
    | "executionMode"
    | "memoryScope"
    | "skillScope"
    | "allowedSkills"
    | "plannerStrategy"
    | "modelRole"
    | "policyModel"
    | "escalationModel"
    | "evaluatorEscalateOnSignal"
    | "evaluatorSignalIncludes"
    | "evaluatorMaxEscalations"
    | "stopOnSuccess"
  >
>;

export const DEFAULT_CHAT_SCHEDULE_DRAFT: ChatScheduleDraft = {
  open: false,
  editingJobId: null,
  agentId: "",
  name: "",
  prompt: "",
  objective: "",
  successCriteria: "",
  kind: "every",
  everyAmount: "1",
  everyUnit: "hours",
  at: "",
  cronExpr: "0 9 * * *",
  deliveryMode: "local",
  executionMode: "auto",
  memoryScope: "session-summary",
  skillScope: "agent-default",
  allowedSkills: "",
  skillToolName: "",
  skillToolInputJson: "",
  plannerStrategy: "",
  modelRole: "",
  policyModel: "",
  escalationModel: "",
  coordinationMode: "none",
  coordinationAgents: "",
  coordinationMaxAgents: "",
  coordinationRequireApproval: true,
  evaluatorEscalateOnSignal: true,
  evaluatorSignalIncludes: "Needs deeper analysis: yes",
  evaluatorMaxEscalations: "1",
  repairAutoRetryReplacement: true,
  repairAutoStopOptionalSources: false,
  repairMaxAutoRepairsPerRun: "1",
  repairRequireApprovalForPrimarySource: true,
  budgetMaxTokensPerRun: "",
  budgetMaxCostUsdPerRun: "",
  budgetMaxRunsPerHour: "",
  stopOnSuccess: false,
  stopTextIncludes: "",
  stopMaxSuccessfulRuns: "",
  stopMaxTotalRuns: "",
  error: null,
};

export function buildTaskPolicyPresetPatch(
  preset: TaskPolicyPreset,
  current?: Pick<
    ChatScheduleDraft,
    | "allowedSkills"
    | "skillScope"
    | "skillToolName"
    | "evaluatorSignalIncludes"
    | "evaluatorMaxEscalations"
  >,
): TaskPolicyPresetPatch {
  const signalIncludes =
    current?.evaluatorSignalIncludes?.trim() || DEFAULT_CHAT_SCHEDULE_DRAFT.evaluatorSignalIncludes;
  const maxEscalations =
    current?.evaluatorMaxEscalations?.trim() || DEFAULT_CHAT_SCHEDULE_DRAFT.evaluatorMaxEscalations;
  if (preset === "auto") {
    return {
      executionMode: "auto",
      memoryScope: "session-summary",
      skillScope: "agent-default",
      plannerStrategy: "",
      modelRole: "",
      policyModel: "",
      escalationModel: "",
      evaluatorEscalateOnSignal: true,
      evaluatorSignalIncludes: signalIncludes,
      evaluatorMaxEscalations: maxEscalations,
    };
  }
  if (preset === "cheap-check") {
    return {
      executionMode: "agent-turn",
      memoryScope: "session-summary",
      skillScope: "agent-default",
      plannerStrategy: "cheap-model",
      evaluatorEscalateOnSignal: true,
      evaluatorSignalIncludes: signalIncludes,
      evaluatorMaxEscalations: maxEscalations,
    };
  }
  if (preset === "strong-model") {
    return {
      executionMode: "agent-turn",
      memoryScope: "search",
      skillScope: "agent-default",
      plannerStrategy: "strong-model",
      evaluatorEscalateOnSignal: false,
    };
  }
  if (preset === "skill-only") {
    const skillTool = current?.skillToolName?.trim() ?? "";
    const allowedSkills = current?.allowedSkills?.trim() || skillTool;
    return {
      executionMode: "skill-only",
      memoryScope: "none",
      skillScope: allowedSkills ? "selected" : current?.skillScope || "agent-default",
      ...(allowedSkills ? { allowedSkills } : {}),
      plannerStrategy: "",
      modelRole: "",
      policyModel: "",
      escalationModel: "",
      evaluatorEscalateOnSignal: false,
    };
  }
  if (preset === "no-model") {
    return {
      executionMode: "no-model",
      memoryScope: "none",
      skillScope: "none",
      plannerStrategy: "",
      modelRole: "",
      policyModel: "",
      escalationModel: "",
      evaluatorEscalateOnSignal: false,
    };
  }
  return { stopOnSuccess: true };
}

export type CronState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  cronLoading: boolean;
  cronJobsLoadingMore: boolean;
  cronJobs: CronJob[];
  cronJobsTotal: number;
  cronJobsHasMore: boolean;
  cronJobsNextOffset: number | null;
  cronJobsLimit: number;
  cronJobsQuery: string;
  cronJobsEnabledFilter: CronJobsEnabledFilter;
  cronJobsScheduleKindFilter: CronJobsScheduleKindFilter;
  cronJobsLastStatusFilter: CronJobsLastStatusFilter;
  cronJobsAdaptiveRouteFilter: CronJobsAdaptiveRouteFilter;
  cronJobsSortBy: CronJobsSortBy;
  cronJobsSortDir: CronSortDir;
  cronStatus: CronStatus | null;
  cronError: string | null;
  cronForm: CronFormState;
  cronFieldErrors: CronFieldErrors;
  cronEditingJobId: string | null;
  cronRunsJobId: string | null;
  cronRunsLoadingMore: boolean;
  cronRuns: CronRunLogEntry[];
  cronRunsTotal: number;
  cronRunsHasMore: boolean;
  cronRunsNextOffset: number | null;
  cronRunsLimit: number;
  cronRunsScope: CronRunScope;
  cronRunsStatuses: CronRunsStatusValue[];
  cronRunsDeliveryStatuses: CronDeliveryStatus[];
  cronRunsStatusFilter: CronRunsStatusFilter;
  cronRunsQuery: string;
  cronRunsSortDir: CronSortDir;
  cronRunDetail: CronTaskRunDetail | null;
  cronRunDetailLoading: boolean;
  cronRunDetailError: string | null;
  cronBusy: boolean;
};

export type ChatScheduleCronInput = {
  draft: ChatScheduleDraft;
  agentId: string;
  sessionKey: string;
  delivery?: CronDelivery;
};

export type ChatScheduleCronUpdateInput = ChatScheduleCronInput & {
  jobId: string;
  existingJob?: CronJob | null;
};

export type CronModelSuggestionsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  cronModelSuggestions: string[];
  sessionKey?: string | null;
};

export function supportsAnnounceDelivery(
  form: Pick<CronFormState, "sessionTarget" | "payloadKind">,
) {
  return form.sessionTarget !== "main" && form.payloadKind === "agentTurn";
}

export function normalizeCronFormState(form: CronFormState): CronFormState {
  if (form.deliveryMode !== "announce") {
    return form;
  }
  if (supportsAnnounceDelivery(form)) {
    return form;
  }
  return {
    ...form,
    deliveryMode: "none",
  };
}

export function validateCronForm(form: CronFormState): CronFieldErrors {
  const errors: CronFieldErrors = {};
  if (!form.name.trim()) {
    errors.name = "cron.errors.nameRequired";
  }
  if (form.scheduleKind === "at") {
    const ms = Date.parse(form.scheduleAt);
    if (!Number.isFinite(ms)) {
      errors.scheduleAt = "cron.errors.scheduleAtInvalid";
    }
  } else if (form.scheduleKind === "every") {
    const amount = toNumber(form.everyAmount, 0);
    if (amount <= 0) {
      errors.everyAmount = "cron.errors.everyAmountInvalid";
    }
  } else {
    if (!form.cronExpr.trim()) {
      errors.cronExpr = "cron.errors.cronExprRequired";
    }
    if (!form.scheduleExact) {
      const staggerAmount = form.staggerAmount.trim();
      if (staggerAmount) {
        const stagger = toNumber(staggerAmount, 0);
        if (stagger <= 0) {
          errors.staggerAmount = "cron.errors.staggerAmountInvalid";
        }
      }
    }
  }
  if (!form.payloadText.trim()) {
    errors.payloadText =
      form.payloadKind === "systemEvent"
        ? "cron.errors.systemTextRequired"
        : "cron.errors.agentMessageRequired";
  }
  if (form.payloadKind === "agentTurn") {
    const timeoutRaw = form.timeoutSeconds.trim();
    if (timeoutRaw) {
      const timeout = toNumber(timeoutRaw, 0);
      if (timeout <= 0) {
        errors.timeoutSeconds = "cron.errors.timeoutInvalid";
      }
    }
  }
  if (form.deliveryMode === "webhook") {
    const target = form.deliveryTo.trim();
    if (!target) {
      errors.deliveryTo = "cron.errors.webhookUrlRequired";
    } else if (!/^https?:\/\//i.test(target)) {
      errors.deliveryTo = "cron.errors.webhookUrlInvalid";
    }
  }
  if (form.failureAlertMode === "custom") {
    const afterRaw = form.failureAlertAfter.trim();
    if (afterRaw) {
      const after = toNumber(afterRaw, 0);
      if (!Number.isFinite(after) || after <= 0) {
        errors.failureAlertAfter = "Failure alert threshold must be greater than 0.";
      }
    }
    const cooldownRaw = form.failureAlertCooldownSeconds.trim();
    if (cooldownRaw) {
      const cooldown = toNumber(cooldownRaw, -1);
      if (!Number.isFinite(cooldown) || cooldown < 0) {
        errors.failureAlertCooldownSeconds = "Cooldown must be 0 or greater.";
      }
    }
  }
  return errors;
}

export function hasCronFormErrors(errors: CronFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

export async function loadCronStatus(state: CronState) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = await state.client.request<CronStatus>("cron.status", {});
    state.cronStatus = res;
  } catch (err) {
    if (isMissingOperatorReadScopeError(err)) {
      state.cronStatus = null;
      state.cronError = formatMissingOperatorReadScopeMessage("cron status");
    } else {
      state.cronError = String(err);
    }
  }
}

export async function loadCronModelSuggestions(state: CronModelSuggestionsState) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const models = await loadModels(state.client, {
      available: true,
      sessionKey: state.sessionKey,
    });
    const ids = models
      .map((entry) => {
        const provider = entry.provider?.trim();
        const id = entry.id?.trim();
        return provider && id ? `${provider}/${id}` : "";
      })
      .filter(Boolean);
    state.cronModelSuggestions = Array.from(new Set(ids)).toSorted((a, b) => a.localeCompare(b));
  } catch {
    state.cronModelSuggestions = [];
  }
}

export async function loadCronJobs(state: CronState, opts?: { quiet?: boolean }) {
  return await loadCronJobsPage(state, { append: false, quiet: opts?.quiet });
}

function normalizeCronPageMeta(params: {
  totalRaw: unknown;
  limitRaw: unknown;
  offsetRaw: unknown;
  nextOffsetRaw: unknown;
  hasMoreRaw: unknown;
  pageCount: number;
}) {
  const total =
    typeof params.totalRaw === "number" && Number.isFinite(params.totalRaw)
      ? Math.max(0, Math.floor(params.totalRaw))
      : params.pageCount;
  const limit =
    typeof params.limitRaw === "number" && Number.isFinite(params.limitRaw)
      ? Math.max(1, Math.floor(params.limitRaw))
      : Math.max(1, params.pageCount);
  const offset =
    typeof params.offsetRaw === "number" && Number.isFinite(params.offsetRaw)
      ? Math.max(0, Math.floor(params.offsetRaw))
      : 0;
  const hasMore =
    typeof params.hasMoreRaw === "boolean"
      ? params.hasMoreRaw
      : offset + params.pageCount < Math.max(total, offset + params.pageCount);
  const nextOffset =
    typeof params.nextOffsetRaw === "number" && Number.isFinite(params.nextOffsetRaw)
      ? Math.max(0, Math.floor(params.nextOffsetRaw))
      : hasMore
        ? offset + params.pageCount
        : null;
  return { total, limit, offset, hasMore, nextOffset };
}

export async function loadCronJobsPage(
  state: CronState,
  opts?: { append?: boolean; quiet?: boolean },
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.cronLoading || state.cronJobsLoadingMore) {
    return;
  }
  const append = opts?.append === true;
  const quiet = opts?.quiet === true && !append;
  if (append) {
    if (!state.cronJobsHasMore) {
      return;
    }
    state.cronJobsLoadingMore = true;
  } else if (!quiet) {
    state.cronLoading = true;
  }
  state.cronError = null;
  try {
    const offset = append ? Math.max(0, state.cronJobsNextOffset ?? state.cronJobs.length) : 0;
    const res = await state.client.request<CronJobsListResult>("cron.list", {
      includeDisabled: state.cronJobsEnabledFilter === "all",
      limit: state.cronJobsLimit,
      offset,
      query: state.cronJobsQuery.trim() || undefined,
      enabled: state.cronJobsEnabledFilter,
      sortBy: state.cronJobsSortBy,
      sortDir: state.cronJobsSortDir,
    });
    const jobs = Array.isArray(res.jobs) ? res.jobs : [];
    state.cronJobs = append ? [...state.cronJobs, ...jobs] : jobs;
    const meta = normalizeCronPageMeta({
      totalRaw: res.total,
      limitRaw: res.limit,
      offsetRaw: res.offset,
      nextOffsetRaw: res.nextOffset,
      hasMoreRaw: res.hasMore,
      pageCount: jobs.length,
    });
    state.cronJobsTotal = Math.max(meta.total, state.cronJobs.length);
    state.cronJobsHasMore = meta.hasMore;
    state.cronJobsNextOffset = meta.nextOffset;
    if (
      state.cronEditingJobId &&
      !state.cronJobs.some((job) => job.id === state.cronEditingJobId)
    ) {
      clearCronEditState(state);
    }
  } catch (err) {
    state.cronError = String(err);
  } finally {
    if (append) {
      state.cronJobsLoadingMore = false;
    } else if (!quiet) {
      state.cronLoading = false;
    }
  }
}

export async function loadMoreCronJobs(state: CronState) {
  await loadCronJobsPage(state, { append: true });
}

export async function reloadCronJobs(state: CronState) {
  await loadCronJobsPage(state, { append: false });
}

export function updateCronJobsFilter(
  state: CronState,
  patch: Partial<
    Pick<
      CronState,
      | "cronJobsQuery"
      | "cronJobsEnabledFilter"
      | "cronJobsScheduleKindFilter"
      | "cronJobsLastStatusFilter"
      | "cronJobsAdaptiveRouteFilter"
      | "cronJobsSortBy"
      | "cronJobsSortDir"
    >
  >,
) {
  if (typeof patch.cronJobsQuery === "string") {
    state.cronJobsQuery = patch.cronJobsQuery;
  }
  if (patch.cronJobsEnabledFilter) {
    state.cronJobsEnabledFilter = patch.cronJobsEnabledFilter;
  }
  if (patch.cronJobsScheduleKindFilter) {
    state.cronJobsScheduleKindFilter = patch.cronJobsScheduleKindFilter;
  }
  if (patch.cronJobsLastStatusFilter) {
    state.cronJobsLastStatusFilter = patch.cronJobsLastStatusFilter;
  }
  if (patch.cronJobsAdaptiveRouteFilter) {
    state.cronJobsAdaptiveRouteFilter = patch.cronJobsAdaptiveRouteFilter;
  }
  if (patch.cronJobsSortBy) {
    state.cronJobsSortBy = patch.cronJobsSortBy;
  }
  if (patch.cronJobsSortDir) {
    state.cronJobsSortDir = patch.cronJobsSortDir;
  }
}

export function getVisibleCronJobs(
  state: Pick<
    CronState,
    | "cronJobs"
    | "cronJobsQuery"
    | "cronJobsEnabledFilter"
    | "cronJobsScheduleKindFilter"
    | "cronJobsLastStatusFilter"
    | "cronJobsAdaptiveRouteFilter"
  >,
): CronJob[] {
  const query = state.cronJobsQuery.trim().toLowerCase();
  return state.cronJobs.filter((job) => {
    if (state.cronJobsEnabledFilter === "enabled" && !job.enabled) {
      return false;
    }
    if (state.cronJobsEnabledFilter === "disabled" && job.enabled) {
      return false;
    }
    if (
      state.cronJobsScheduleKindFilter !== "all" &&
      job.schedule.kind !== state.cronJobsScheduleKindFilter
    ) {
      return false;
    }
    if (
      state.cronJobsLastStatusFilter !== "all" &&
      job.state?.lastStatus !== state.cronJobsLastStatusFilter
    ) {
      return false;
    }
    if (
      state.cronJobsAdaptiveRouteFilter !== "all" &&
      job.state?.adaptiveRouting?.lastDecision?.route !== state.cronJobsAdaptiveRouteFilter
    ) {
      return false;
    }
    if (query) {
      const payloadText = job.payload.kind === "agentTurn" ? job.payload.message : job.payload.text;
      const delivery = job.delivery
        ? [job.delivery.mode, job.delivery.channel, job.delivery.to, job.delivery.accountId]
            .filter(Boolean)
            .join(" ")
        : "";
      const adaptiveRoute = job.state?.adaptiveRouting?.lastDecision?.route ?? "";
      return [
        job.name,
        job.id,
        job.description,
        payloadText,
        job.sessionKey,
        delivery,
        adaptiveRoute,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    }
    return true;
  });
}

function clearCronEditState(state: CronState) {
  state.cronEditingJobId = null;
}

function resetCronFormToDefaults(state: CronState) {
  state.cronForm = { ...DEFAULT_CRON_FORM };
  state.cronFieldErrors = validateCronForm(state.cronForm);
}

function formatDateTimeLocal(input: string): string {
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) {
    return "";
  }
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function parseEverySchedule(everyMs: number): Pick<CronFormState, "everyAmount" | "everyUnit"> {
  if (everyMs % 86_400_000 === 0) {
    return { everyAmount: String(Math.max(1, everyMs / 86_400_000)), everyUnit: "days" };
  }
  if (everyMs % 3_600_000 === 0) {
    return { everyAmount: String(Math.max(1, everyMs / 3_600_000)), everyUnit: "hours" };
  }
  const minutes = Math.max(1, Math.ceil(everyMs / 60_000));
  return { everyAmount: String(minutes), everyUnit: "minutes" };
}

function parseStaggerSchedule(
  staggerMs?: number,
): Pick<CronFormState, "scheduleExact" | "staggerAmount" | "staggerUnit"> {
  if (staggerMs === 0) {
    return { scheduleExact: true, staggerAmount: "", staggerUnit: "seconds" };
  }
  if (typeof staggerMs !== "number" || !Number.isFinite(staggerMs) || staggerMs < 0) {
    return { scheduleExact: false, staggerAmount: "", staggerUnit: "seconds" };
  }
  if (staggerMs % 60_000 === 0) {
    return {
      scheduleExact: false,
      staggerAmount: String(Math.max(1, staggerMs / 60_000)),
      staggerUnit: "minutes",
    };
  }
  return {
    scheduleExact: false,
    staggerAmount: String(Math.max(1, Math.ceil(staggerMs / 1_000))),
    staggerUnit: "seconds",
  };
}

export function cronJobToForm(job: CronJob, prev: CronFormState): CronFormState {
  const failureAlert = job.failureAlert;
  const executionPolicy = job.executionPolicy;
  const next: CronFormState = {
    ...prev,
    name: job.name,
    description: job.description ?? "",
    agentId: job.agentId ?? "",
    sessionKey: job.sessionKey ?? "",
    clearAgent: false,
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun ?? false,
    scheduleKind: job.schedule.kind,
    scheduleAt: "",
    everyAmount: prev.everyAmount,
    everyUnit: prev.everyUnit,
    cronExpr: prev.cronExpr,
    cronTz: "",
    scheduleExact: false,
    staggerAmount: "",
    staggerUnit: "seconds",
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    taskObjective: executionPolicy?.objective ?? "",
    taskSuccessCriteria: executionPolicy?.successCriteria ?? "",
    executionMode: executionPolicy?.executionMode ?? "auto",
    memoryScope: executionPolicy?.memoryScope ?? "session-summary",
    skillScope: executionPolicy?.skillScope ?? "agent-default",
    allowedSkills: (executionPolicy?.allowedSkills ?? []).join(", "),
    skillToolName: executionPolicy?.skillAction?.toolName ?? "",
    skillToolInputJson: executionPolicy?.skillAction?.input
      ? JSON.stringify(executionPolicy.skillAction.input, null, 2)
      : "",
    plannerStrategy:
      executionPolicy?.planner?.strategy === "cheap-model" ||
      executionPolicy?.planner?.strategy === "strong-model"
        ? executionPolicy.planner.strategy
        : "",
    policyModel: executionPolicy?.modelPolicy?.model ?? "",
    modelRole: executionPolicy?.modelPolicy?.role ?? "",
    escalationModel: executionPolicy?.modelPolicy?.escalationModel ?? "",
    coordinationMode: executionPolicy?.coordination?.mode ?? "none",
    coordinationAgents: Array.isArray(executionPolicy?.coordination?.agents)
      ? executionPolicy.coordination.agents.join(", ")
      : "",
    coordinationMaxAgents:
      typeof executionPolicy?.coordination?.maxAgents === "number"
        ? String(executionPolicy.coordination.maxAgents)
        : "",
    coordinationRequireApproval: executionPolicy?.coordination?.requireApproval !== false,
    evaluatorEscalateOnSignal: executionPolicy?.evaluator?.escalateOnSignal !== false,
    evaluatorSignalIncludes:
      executionPolicy?.evaluator?.signalIncludes?.join(", ") ??
      DEFAULT_CRON_FORM.evaluatorSignalIncludes,
    evaluatorMaxEscalations:
      typeof executionPolicy?.evaluator?.maxEscalations === "number"
        ? String(executionPolicy.evaluator.maxEscalations)
        : DEFAULT_CRON_FORM.evaluatorMaxEscalations,
    repairAutoRetryReplacement: executionPolicy?.repairPolicy?.autoRetryReplacement !== false,
    repairAutoStopOptionalSources: executionPolicy?.repairPolicy?.autoStopOptionalSources === true,
    repairMaxAutoRepairsPerRun:
      typeof executionPolicy?.repairPolicy?.maxAutoRepairsPerRun === "number"
        ? String(executionPolicy.repairPolicy.maxAutoRepairsPerRun)
        : DEFAULT_CRON_FORM.repairMaxAutoRepairsPerRun,
    repairRequireApprovalForPrimarySource:
      executionPolicy?.repairPolicy?.requireApprovalForPrimarySource !== false,
    budgetMaxTokensPerRun:
      typeof executionPolicy?.budget?.maxTokensPerRun === "number"
        ? String(executionPolicy.budget.maxTokensPerRun)
        : "",
    budgetMaxCostUsdPerRun:
      typeof executionPolicy?.budget?.maxCostUsdPerRun === "number"
        ? String(executionPolicy.budget.maxCostUsdPerRun)
        : "",
    budgetMaxRunsPerHour:
      typeof executionPolicy?.budget?.maxRunsPerHour === "number"
        ? String(executionPolicy.budget.maxRunsPerHour)
        : "",
    stopOnSuccess: executionPolicy?.stop?.onSuccess === true,
    stopTextIncludes: Array.isArray(executionPolicy?.stop?.outputIncludes)
      ? executionPolicy.stop.outputIncludes.join(", ")
      : "",
    stopMaxSuccessfulRuns:
      typeof executionPolicy?.stop?.maxSuccessfulRuns === "number"
        ? String(executionPolicy.stop.maxSuccessfulRuns)
        : "",
    stopMaxTotalRuns:
      typeof executionPolicy?.stop?.maxTotalRuns === "number"
        ? String(executionPolicy.stop.maxTotalRuns)
        : "",
    payloadKind: job.payload.kind,
    payloadText: job.payload.kind === "systemEvent" ? job.payload.text : job.payload.message,
    payloadModel: job.payload.kind === "agentTurn" ? (job.payload.model ?? "") : "",
    payloadThinking: job.payload.kind === "agentTurn" ? (job.payload.thinking ?? "") : "",
    payloadLightContext:
      job.payload.kind === "agentTurn" ? job.payload.lightContext === true : false,
    deliveryMode: job.delivery?.mode ?? "none",
    deliveryChannel: job.delivery?.channel ?? CRON_CHANNEL_LAST,
    deliveryTo: job.delivery?.to ?? "",
    deliveryAccountId: job.delivery?.accountId ?? "",
    deliveryBestEffort: job.delivery?.bestEffort ?? false,
    failureAlertMode:
      failureAlert === false
        ? "disabled"
        : failureAlert && typeof failureAlert === "object"
          ? "custom"
          : "inherit",
    failureAlertAfter:
      failureAlert && typeof failureAlert === "object" && typeof failureAlert.after === "number"
        ? String(failureAlert.after)
        : DEFAULT_CRON_FORM.failureAlertAfter,
    failureAlertCooldownSeconds:
      failureAlert &&
      typeof failureAlert === "object" &&
      typeof failureAlert.cooldownMs === "number"
        ? String(Math.floor(failureAlert.cooldownMs / 1000))
        : DEFAULT_CRON_FORM.failureAlertCooldownSeconds,
    failureAlertChannel:
      failureAlert && typeof failureAlert === "object"
        ? (failureAlert.channel ?? CRON_CHANNEL_LAST)
        : CRON_CHANNEL_LAST,
    failureAlertTo: failureAlert && typeof failureAlert === "object" ? (failureAlert.to ?? "") : "",
    failureAlertDeliveryMode:
      failureAlert && typeof failureAlert === "object"
        ? (failureAlert.mode ?? "announce")
        : "announce",
    failureAlertAccountId:
      failureAlert && typeof failureAlert === "object" ? (failureAlert.accountId ?? "") : "",
    timeoutSeconds:
      job.payload.kind === "agentTurn" && typeof job.payload.timeoutSeconds === "number"
        ? String(job.payload.timeoutSeconds)
        : "",
  };

  if (job.schedule.kind === "at") {
    next.scheduleAt = formatDateTimeLocal(job.schedule.at);
  } else if (job.schedule.kind === "every") {
    const parsed = parseEverySchedule(job.schedule.everyMs);
    next.everyAmount = parsed.everyAmount;
    next.everyUnit = parsed.everyUnit;
  } else {
    next.cronExpr = job.schedule.expr;
    next.cronTz = job.schedule.tz ?? "";
    const staggerFields = parseStaggerSchedule(job.schedule.staggerMs);
    next.scheduleExact = staggerFields.scheduleExact;
    next.staggerAmount = staggerFields.staggerAmount;
    next.staggerUnit = staggerFields.staggerUnit;
  }

  return normalizeCronFormState(next);
}

export function buildCronSchedule(form: CronFormState) {
  if (form.scheduleKind === "at") {
    const ms = Date.parse(form.scheduleAt);
    if (!Number.isFinite(ms)) {
      throw new Error(t("cron.errors.invalidRunTime"));
    }
    return { kind: "at" as const, at: new Date(ms).toISOString() };
  }
  if (form.scheduleKind === "every") {
    const amount = toNumber(form.everyAmount, 0);
    if (amount <= 0) {
      throw new Error(t("cron.errors.invalidIntervalAmount"));
    }
    const unit = form.everyUnit;
    const mult = unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : 86_400_000;
    return { kind: "every" as const, everyMs: amount * mult };
  }
  const expr = form.cronExpr.trim();
  if (!expr) {
    throw new Error(t("cron.errors.cronExprRequiredShort"));
  }
  if (form.scheduleExact) {
    return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined, staggerMs: 0 };
  }
  const staggerAmount = form.staggerAmount.trim();
  if (!staggerAmount) {
    return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined };
  }
  const staggerValue = toNumber(staggerAmount, 0);
  if (staggerValue <= 0) {
    throw new Error(t("cron.errors.invalidStaggerAmount"));
  }
  const staggerMs = form.staggerUnit === "minutes" ? staggerValue * 60_000 : staggerValue * 1_000;
  return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined, staggerMs };
}

export function buildCronPayload(form: CronFormState) {
  if (form.payloadKind === "systemEvent") {
    const text = form.payloadText.trim();
    if (!text) {
      throw new Error(t("cron.errors.systemEventTextRequired"));
    }
    return { kind: "systemEvent" as const, text };
  }
  const message = form.payloadText.trim();
  if (!message) {
    throw new Error(t("cron.errors.agentMessageRequiredShort"));
  }
  const payload: {
    kind: "agentTurn";
    message: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    lightContext?: boolean;
  } = { kind: "agentTurn", message };
  const model = form.payloadModel.trim();
  if (model) {
    payload.model = model;
  }
  const thinking = form.payloadThinking.trim();
  if (thinking) {
    payload.thinking = thinking;
  }
  const timeoutSeconds = toNumber(form.timeoutSeconds, 0);
  if (timeoutSeconds > 0) {
    payload.timeoutSeconds = timeoutSeconds;
  }
  if (form.payloadLightContext) {
    payload.lightContext = true;
  }
  return payload;
}

function parseCsvList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function parseOptionalNonNegativeNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOptionalPositiveInteger(raw: string): number | undefined {
  const parsed = parseOptionalNonNegativeNumber(raw);
  if (parsed === undefined || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function buildTaskEvaluatorPolicy(fields: {
  evaluatorEscalateOnSignal: boolean;
  evaluatorSignalIncludes: string;
  evaluatorMaxEscalations: string;
}): CronTaskExecutionPolicy["evaluator"] {
  const evaluator: NonNullable<CronTaskExecutionPolicy["evaluator"]> = {
    escalateOnSignal: fields.evaluatorEscalateOnSignal,
  };
  if (fields.evaluatorEscalateOnSignal) {
    const signalIncludes = parseCsvList(fields.evaluatorSignalIncludes);
    if (signalIncludes.length > 0) {
      evaluator.signalIncludes = signalIncludes;
    }
    const maxEscalations = parseOptionalPositiveInteger(fields.evaluatorMaxEscalations);
    if (maxEscalations !== undefined) {
      evaluator.maxEscalations = maxEscalations;
    }
  }
  return evaluator;
}

function buildTaskRepairPolicy(fields: {
  repairAutoRetryReplacement: boolean;
  repairAutoStopOptionalSources: boolean;
  repairMaxAutoRepairsPerRun: string;
  repairRequireApprovalForPrimarySource: boolean;
}): CronTaskExecutionPolicy["repairPolicy"] {
  const repairPolicy: NonNullable<CronTaskExecutionPolicy["repairPolicy"]> = {
    autoRetryReplacement: fields.repairAutoRetryReplacement,
    autoStopOptionalSources: fields.repairAutoStopOptionalSources,
    requireApprovalForPrimarySource: fields.repairRequireApprovalForPrimarySource,
  };
  const maxAutoRepairsPerRun = parseOptionalPositiveInteger(fields.repairMaxAutoRepairsPerRun);
  if (maxAutoRepairsPerRun !== undefined) {
    repairPolicy.maxAutoRepairsPerRun = maxAutoRepairsPerRun;
  }
  return repairPolicy;
}

function buildTaskCoordinationPolicy(fields: {
  coordinationMode: ChatScheduleDraft["coordinationMode"];
  coordinationAgents: string;
  coordinationMaxAgents: string;
  coordinationRequireApproval: boolean;
}): CronTaskExecutionPolicy["coordination"] | undefined {
  const agents = parseCsvList(fields.coordinationAgents);
  const maxAgents = parseOptionalPositiveInteger(fields.coordinationMaxAgents);
  if (fields.coordinationMode === "none" && agents.length === 0 && maxAgents === undefined) {
    return undefined;
  }
  const mode =
    fields.coordinationMode === "none" && agents.length > 0 ? "consult" : fields.coordinationMode;
  return {
    mode,
    ...(agents.length > 0 ? { agents } : {}),
    ...(maxAgents !== undefined ? { maxAgents } : {}),
    requireApproval: fields.coordinationRequireApproval,
  };
}

function canUseModelPlanner(fields: { executionMode: ChatScheduleDraft["executionMode"] }) {
  return fields.executionMode !== "no-model" && fields.executionMode !== "skill-only";
}

function buildExplicitPlanner(fields: {
  executionMode: ChatScheduleDraft["executionMode"];
  plannerStrategy?: ChatScheduleDraft["plannerStrategy"];
}): CronTaskExecutionPolicy["planner"] | undefined {
  if (!fields.plannerStrategy || !canUseModelPlanner(fields)) {
    return undefined;
  }
  if (fields.plannerStrategy === "cheap-model") {
    return {
      source: "heuristic",
      strategy: "cheap-model",
      rationale: "Manual cheap-check task policy.",
      confidence: "high",
      signals: ["manual-preset"],
    };
  }
  return {
    source: "heuristic",
    strategy: "strong-model",
    rationale: "Manual strong-model task policy.",
    confidence: "high",
    signals: ["manual-preset"],
  };
}

function shouldForceCheapCheckPlanner(fields: {
  executionMode: ChatScheduleDraft["executionMode"];
  policyModel: string;
  evaluatorEscalateOnSignal: boolean;
}) {
  return (
    fields.evaluatorEscalateOnSignal &&
    canUseModelPlanner(fields) &&
    fields.policyModel.trim().length > 0
  );
}

function buildTaskPlanner(fields: {
  executionMode: ChatScheduleDraft["executionMode"];
  plannerStrategy?: ChatScheduleDraft["plannerStrategy"];
  policyModel: string;
  evaluatorEscalateOnSignal: boolean;
}): CronTaskExecutionPolicy["planner"] | undefined {
  const explicit = buildExplicitPlanner(fields);
  if (explicit) {
    return explicit;
  }
  if (!shouldForceCheapCheckPlanner(fields)) {
    return undefined;
  }
  return {
    source: "heuristic",
    strategy: "cheap-model",
    rationale: "Manual cheap-check evaluator settings.",
    confidence: "high",
    signals: ["manual-evaluator"],
  };
}

function parseSkillInputJson(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Skill input must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Skill input must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function buildCronExecutionPolicy(form: CronFormState): CronTaskExecutionPolicy {
  const allowedSkills = parseCsvList(form.allowedSkills);
  const stopTextIncludes = parseCsvList(form.stopTextIncludes);
  const skillToolName = form.skillToolName.trim();
  const skillInput = parseSkillInputJson(form.skillToolInputJson);
  const modelPolicy: NonNullable<CronTaskExecutionPolicy["modelPolicy"]> = {
    mode:
      form.executionMode === "no-model"
        ? "none"
        : form.policyModel.trim()
          ? "task-override"
          : form.executionMode === "auto"
            ? "auto"
            : "agent-default",
  };
  if (form.policyModel.trim()) {
    modelPolicy.model = form.policyModel.trim();
  }
  if (form.modelRole) {
    modelPolicy.role = form.modelRole;
  }
  if (form.payloadThinking.trim()) {
    modelPolicy.thinking = form.payloadThinking.trim();
  }
  if (form.escalationModel.trim()) {
    modelPolicy.escalationModel = form.escalationModel.trim();
  }

  const budget: NonNullable<CronTaskExecutionPolicy["budget"]> = {};
  const maxTokensPerRun = parseOptionalNonNegativeNumber(form.budgetMaxTokensPerRun);
  if (maxTokensPerRun !== undefined) {
    budget.maxTokensPerRun = maxTokensPerRun;
  }
  const maxCostUsdPerRun = parseOptionalNonNegativeNumber(form.budgetMaxCostUsdPerRun);
  if (maxCostUsdPerRun !== undefined) {
    budget.maxCostUsdPerRun = maxCostUsdPerRun;
  }
  const maxRunsPerHour = parseOptionalNonNegativeNumber(form.budgetMaxRunsPerHour);
  if (maxRunsPerHour !== undefined) {
    budget.maxRunsPerHour = maxRunsPerHour;
  }
  const stop: NonNullable<CronTaskExecutionPolicy["stop"]> = {};
  if (form.stopOnSuccess) {
    stop.onSuccess = true;
  }
  if (stopTextIncludes.length > 0) {
    stop.outputIncludes = stopTextIncludes;
  }
  const maxSuccessfulRuns = parseOptionalPositiveInteger(form.stopMaxSuccessfulRuns);
  if (maxSuccessfulRuns !== undefined) {
    stop.maxSuccessfulRuns = maxSuccessfulRuns;
  }
  const maxTotalRuns = parseOptionalPositiveInteger(form.stopMaxTotalRuns);
  if (maxTotalRuns !== undefined) {
    stop.maxTotalRuns = maxTotalRuns;
  }
  const coordination = buildTaskCoordinationPolicy(form);
  const planner = buildTaskPlanner(form);

  return {
    ...(form.taskObjective.trim() ? { objective: form.taskObjective.trim() } : {}),
    ...(form.taskSuccessCriteria.trim()
      ? { successCriteria: form.taskSuccessCriteria.trim() }
      : {}),
    triggerKind: "schedule",
    executionMode: form.executionMode,
    memoryScope: form.memoryScope,
    skillScope: form.skillScope,
    ...(allowedSkills.length > 0 ? { allowedSkills } : {}),
    ...(skillToolName
      ? {
          skillAction: {
            toolName: skillToolName,
            ...(skillInput ? { input: skillInput } : {}),
          },
        }
      : {}),
    modelPolicy,
    ...(planner ? { planner } : {}),
    evaluator: buildTaskEvaluatorPolicy(form),
    repairPolicy: buildTaskRepairPolicy(form),
    ...(coordination ? { coordination } : {}),
    ...(Object.keys(budget).length > 0 ? { budget } : {}),
    ...(Object.keys(stop).length > 0 ? { stop } : {}),
  };
}

function buildFailureAlert(form: CronFormState) {
  if (form.failureAlertMode === "disabled") {
    return false as const;
  }
  if (form.failureAlertMode !== "custom") {
    return undefined;
  }
  const after = toNumber(form.failureAlertAfter.trim(), 0);
  const cooldownRaw = form.failureAlertCooldownSeconds.trim();
  const cooldownSeconds = cooldownRaw.length > 0 ? toNumber(cooldownRaw, 0) : undefined;
  const cooldownMs =
    cooldownSeconds !== undefined && Number.isFinite(cooldownSeconds) && cooldownSeconds >= 0
      ? Math.floor(cooldownSeconds * 1000)
      : undefined;
  const deliveryMode = form.failureAlertDeliveryMode;
  const accountId = form.failureAlertAccountId.trim();
  const patch: Record<string, unknown> = {
    after: after > 0 ? Math.floor(after) : undefined,
    channel: form.failureAlertChannel.trim() || CRON_CHANNEL_LAST,
    to: form.failureAlertTo.trim() || undefined,
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
  };
  // Always include mode and accountId so users can switch/clear them
  if (deliveryMode) {
    patch.mode = deliveryMode;
  }
  // Include accountId if explicitly set, or send undefined to allow clearing
  patch.accountId = accountId || undefined;
  return patch;
}

export async function addCronJob(state: CronState) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    const form = normalizeCronFormState(state.cronForm);
    if (form !== state.cronForm) {
      state.cronForm = form;
    }
    const fieldErrors = validateCronForm(form);
    state.cronFieldErrors = fieldErrors;
    if (hasCronFormErrors(fieldErrors)) {
      return;
    }

    const schedule = buildCronSchedule(form);
    const payload = buildCronPayload(form);
    const executionPolicy = buildCronExecutionPolicy(form);
    const editingJob = state.cronEditingJobId
      ? state.cronJobs.find((job) => job.id === state.cronEditingJobId)
      : undefined;
    if (payload.kind === "agentTurn") {
      const existingLightContext =
        editingJob?.payload.kind === "agentTurn" ? editingJob.payload.lightContext : undefined;
      if (
        !form.payloadLightContext &&
        state.cronEditingJobId &&
        existingLightContext !== undefined
      ) {
        payload.lightContext = false;
      }
    }
    const selectedDeliveryMode = form.deliveryMode;
    const deliveryAccountId = form.deliveryAccountId.trim();
    const nextDeliveryAccountId =
      selectedDeliveryMode === "announce"
        ? deliveryAccountId ||
          (state.cronEditingJobId && editingJob?.delivery?.accountId ? "" : undefined)
        : undefined;
    const delivery =
      selectedDeliveryMode && selectedDeliveryMode !== "none"
        ? {
            mode: selectedDeliveryMode,
            channel:
              selectedDeliveryMode === "announce"
                ? form.deliveryChannel.trim() || "last"
                : undefined,
            to: form.deliveryTo.trim() || undefined,
            accountId: nextDeliveryAccountId,
            bestEffort: form.deliveryBestEffort,
          }
        : selectedDeliveryMode === "none"
          ? ({ mode: "none" } as const)
          : undefined;
    const failureAlert = buildFailureAlert(form);
    const agentId = form.clearAgent ? null : form.agentId.trim();
    const sessionKeyRaw = form.sessionKey.trim();
    const sessionKey = sessionKeyRaw || (editingJob?.sessionKey ? null : undefined);
    const job = {
      name: form.name.trim(),
      description: form.description.trim(),
      agentId: agentId === null ? null : agentId || undefined,
      sessionKey,
      enabled: form.enabled,
      deleteAfterRun: form.deleteAfterRun,
      schedule,
      sessionTarget: form.sessionTarget,
      wakeMode: form.wakeMode,
      payload,
      delivery,
      executionPolicy,
      failureAlert,
    };
    if (!job.name) {
      throw new Error(t("cron.errors.nameRequiredShort"));
    }
    if (state.cronEditingJobId) {
      await state.client.request("cron.update", {
        id: state.cronEditingJobId,
        patch: job,
      });
      clearCronEditState(state);
    } else {
      await state.client.request("cron.add", job);
      resetCronFormToDefaults(state);
    }
    await loadCronJobs(state);
    await loadCronStatus(state);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function toggleCronJob(state: CronState, job: CronJob, enabled: boolean) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.update", { id: job.id, patch: { enabled } });
    await loadCronJobs(state);
    await loadCronStatus(state);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function runCronJob(state: CronState, job: CronJob, mode: "force" | "due" = "force") {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.run", { id: job.id, mode });
    await loadCronJobs(state);
    await loadCronStatus(state);
    if (state.cronRunsScope === "all") {
      await loadCronRuns(state, null);
    } else {
      await loadCronRuns(state, job.id);
    }
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function approveCronTaskCoordination(
  state: CronState,
  job: CronJob,
  opts?: { run?: boolean },
) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.update", {
      id: job.id,
      patch: {
        state: {
          coordinationApprovedAtMs: Date.now(),
        },
      },
    });
    if (opts?.run !== false) {
      await state.client.request("cron.run", { id: job.id, mode: "force" });
    }
    await loadCronJobs(state);
    await loadCronStatus(state);
    if (state.cronRunsScope === "all") {
      await loadCronRuns(state, null);
    } else if (state.cronRunsJobId === job.id) {
      await loadCronRuns(state, job.id);
    }
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function askCronTaskAgentEvidence(state: CronState, job: CronJob) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  const coordination = job.executionPolicy?.coordination;
  const agents = (coordination?.agents ?? []).map((agent) => agent.trim()).filter(Boolean);
  if (!coordination?.mode || coordination.mode === "none" || agents.length === 0) {
    state.cronError =
      "Choose one or more Ask Agents for this task before retrying with Agent evidence.";
    return;
  }
  const nowMs = Date.now();
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.update", {
      id: job.id,
      patch: {
        state: {
          pendingCoordination: {
            reason: `User requested task-room evidence from ${agents.join(", ")}.`,
            signal: "manual_agent_request",
            agents,
            mode: coordination.mode,
            createdAtMs: nowMs,
            sourceRunAtMs: nowMs,
          },
          coordinationApprovedAtMs: nowMs,
        },
      },
    });
    await state.client.request("cron.run", { id: job.id, mode: "force" });
    await loadCronJobs(state);
    await loadCronStatus(state);
    if (state.cronRunsScope === "all") {
      await loadCronRuns(state, null);
    } else if (state.cronRunsJobId === job.id) {
      await loadCronRuns(state, job.id);
    }
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function controlCronQueueRun(
  state: CronState,
  action: "cancel" | "retry" | "clear-stale",
  runId: string,
) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  const method =
    action === "cancel"
      ? "cron.queue.cancel"
      : action === "retry"
        ? "cron.queue.retry"
        : "cron.queue.clearStale";
  const refreshRunDetail = state.cronRunDetail?.runId === runId;
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request(method, { runId });
    await loadCronJobs(state);
    await loadCronStatus(state);
    if (state.cronRunsScope === "all") {
      await loadCronRuns(state, null);
    }
    if (refreshRunDetail) {
      await loadCronRunDetail(state, runId);
    }
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function repairCronTask(
  state: CronState,
  job: CronJob,
  action: CronRepairAction,
  opts?: { source?: string; sourceNodeId?: string },
) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.repair", {
      id: job.id,
      action,
      ...(opts?.source ? { source: opts.source } : {}),
      ...(opts?.sourceNodeId ? { sourceNodeId: opts.sourceNodeId } : {}),
    });
    await loadCronJobs(state);
    await loadCronStatus(state);
    if (state.cronRunsScope === "all") {
      await loadCronRuns(state, null);
    } else if (state.cronRunsJobId === job.id) {
      await loadCronRuns(state, job.id);
    }
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function updateCronTrustedSource(state: CronState, sourceId: string, active: boolean) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  const refreshRunId = state.cronRunDetail?.runId;
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.sources.update", { id: sourceId, active });
    await loadCronJobs(state);
    await loadCronStatus(state);
    if (state.cronRunsScope === "all") {
      await loadCronRuns(state, null);
    } else if (state.cronRunsJobId) {
      await loadCronRuns(state, state.cronRunsJobId);
    }
    if (refreshRunId) {
      await loadCronRunDetail(state, refreshRunId);
    }
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function removeCronTrustedSource(state: CronState, sourceId: string) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  const refreshRunId = state.cronRunDetail?.runId;
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.sources.remove", { id: sourceId });
    await loadCronJobs(state);
    await loadCronStatus(state);
    if (state.cronRunsScope === "all") {
      await loadCronRuns(state, null);
    } else if (state.cronRunsJobId) {
      await loadCronRuns(state, state.cronRunsJobId);
    }
    if (refreshRunId) {
      await loadCronRunDetail(state, refreshRunId);
    }
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function removeCronJob(state: CronState, job: CronJob) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.remove", { id: job.id });
    if (state.cronEditingJobId === job.id) {
      clearCronEditState(state);
    }
    if (state.cronRunsJobId === job.id) {
      state.cronRunsJobId = null;
      state.cronRuns = [];
      state.cronRunsTotal = 0;
      state.cronRunsHasMore = false;
      state.cronRunsNextOffset = null;
    }
    await loadCronJobs(state);
    await loadCronStatus(state);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function loadCronRuns(
  state: CronState,
  jobId: string | null,
  opts?: { append?: boolean },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const scope = state.cronRunsScope;
  const activeJobId = jobId ?? state.cronRunsJobId;
  if (scope === "job" && !activeJobId) {
    state.cronRuns = [];
    state.cronRunsTotal = 0;
    state.cronRunsHasMore = false;
    state.cronRunsNextOffset = null;
    return;
  }
  const append = opts?.append === true;
  if (append && !state.cronRunsHasMore) {
    return;
  }
  try {
    if (append) {
      state.cronRunsLoadingMore = true;
    }
    const offset = append ? Math.max(0, state.cronRunsNextOffset ?? state.cronRuns.length) : 0;
    const res = await state.client.request<CronRunsResult>("cron.runs", {
      scope,
      id: scope === "job" ? (activeJobId ?? undefined) : undefined,
      limit: state.cronRunsLimit,
      offset,
      statuses: state.cronRunsStatuses.length > 0 ? state.cronRunsStatuses : undefined,
      status: state.cronRunsStatusFilter,
      deliveryStatuses:
        state.cronRunsDeliveryStatuses.length > 0 ? state.cronRunsDeliveryStatuses : undefined,
      query: state.cronRunsQuery.trim() || undefined,
      sortDir: state.cronRunsSortDir,
    });
    const entries = Array.isArray(res.entries) ? res.entries : [];
    state.cronRuns =
      append && (scope === "all" || state.cronRunsJobId === activeJobId)
        ? [...state.cronRuns, ...entries]
        : entries;
    if (scope === "job") {
      state.cronRunsJobId = activeJobId ?? null;
    }
    const meta = normalizeCronPageMeta({
      totalRaw: res.total,
      limitRaw: res.limit,
      offsetRaw: res.offset,
      nextOffsetRaw: res.nextOffset,
      hasMoreRaw: res.hasMore,
      pageCount: entries.length,
    });
    state.cronRunsTotal = Math.max(meta.total, state.cronRuns.length);
    state.cronRunsHasMore = meta.hasMore;
    state.cronRunsNextOffset = meta.nextOffset;
  } catch (err) {
    state.cronError = String(err);
  } finally {
    if (append) {
      state.cronRunsLoadingMore = false;
    }
  }
}

export async function loadMoreCronRuns(state: CronState) {
  if (state.cronRunsScope === "job" && !state.cronRunsJobId) {
    return;
  }
  await loadCronRuns(state, state.cronRunsJobId, { append: true });
}

export async function loadCronRunDetail(state: CronState, runId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const normalized = runId.trim();
  if (!normalized) {
    return;
  }
  state.cronRunDetailLoading = true;
  state.cronRunDetailError = null;
  try {
    state.cronRunDetail = await state.client.request<CronTaskRunDetail>("cron.runDetail", {
      runId: normalized,
    });
  } catch (err) {
    state.cronRunDetail = null;
    state.cronRunDetailError = String(err);
  } finally {
    state.cronRunDetailLoading = false;
  }
}

export function closeCronRunDetail(state: CronState) {
  state.cronRunDetail = null;
  state.cronRunDetailError = null;
  state.cronRunDetailLoading = false;
}

export function updateCronRunsFilter(
  state: CronState,
  patch: Partial<
    Pick<
      CronState,
      | "cronRunsScope"
      | "cronRunsStatuses"
      | "cronRunsDeliveryStatuses"
      | "cronRunsStatusFilter"
      | "cronRunsQuery"
      | "cronRunsSortDir"
    >
  >,
) {
  if (patch.cronRunsScope) {
    state.cronRunsScope = patch.cronRunsScope;
  }
  if (Array.isArray(patch.cronRunsStatuses)) {
    state.cronRunsStatuses = patch.cronRunsStatuses;
    state.cronRunsStatusFilter =
      patch.cronRunsStatuses.length === 1 ? patch.cronRunsStatuses[0] : "all";
  }
  if (Array.isArray(patch.cronRunsDeliveryStatuses)) {
    state.cronRunsDeliveryStatuses = patch.cronRunsDeliveryStatuses;
  }
  if (patch.cronRunsStatusFilter) {
    state.cronRunsStatusFilter = patch.cronRunsStatusFilter;
    state.cronRunsStatuses =
      patch.cronRunsStatusFilter === "all" ? [] : [patch.cronRunsStatusFilter];
  }
  if (typeof patch.cronRunsQuery === "string") {
    state.cronRunsQuery = patch.cronRunsQuery;
  }
  if (patch.cronRunsSortDir) {
    state.cronRunsSortDir = patch.cronRunsSortDir;
  }
}

function deriveChatScheduleName(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Scheduled chat task";
  }
  return normalized.length > 56 ? `${normalized.slice(0, 53).trimEnd()}...` : normalized;
}

function formatDateTimeLocalFromMs(ms: number) {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function createChatScheduleDraft(
  prompt: string,
  opts?: { agentId?: string; deliveryMode?: ChatScheduleDeliveryMode; nowMs?: number },
): ChatScheduleDraft {
  const normalizedPrompt = prompt.trim();
  const nowMs = opts?.nowMs ?? Date.now();
  return {
    ...DEFAULT_CHAT_SCHEDULE_DRAFT,
    open: true,
    agentId: opts?.agentId ?? "",
    name: deriveChatScheduleName(normalizedPrompt),
    prompt: normalizedPrompt,
    at: formatDateTimeLocalFromMs(nowMs + 60 * 60 * 1000),
    deliveryMode: opts?.deliveryMode ?? "local",
  };
}

function isChatExecutionMode(value: unknown): value is ChatScheduleDraft["executionMode"] {
  return (
    value === "auto" || value === "agent-turn" || value === "skill-only" || value === "no-model"
  );
}

function isChatMemoryScope(value: unknown): value is ChatScheduleDraft["memoryScope"] {
  return (
    value === "none" ||
    value === "session-summary" ||
    value === "pinned" ||
    value === "search" ||
    value === "agent"
  );
}

function isChatSkillScope(value: unknown): value is ChatScheduleDraft["skillScope"] {
  return value === "none" || value === "selected" || value === "agent-default";
}

function stringifyNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function scheduleDraftParts(
  job: CronJob,
): Pick<ChatScheduleDraft, "kind" | "everyAmount" | "everyUnit" | "at" | "cronExpr"> {
  if (job.schedule.kind === "at") {
    const ms = Date.parse(job.schedule.at);
    return {
      kind: "at",
      everyAmount: "1",
      everyUnit: "hours",
      at: Number.isFinite(ms) ? formatDateTimeLocalFromMs(ms) : "",
      cronExpr: DEFAULT_CHAT_SCHEDULE_DRAFT.cronExpr,
    };
  }
  if (job.schedule.kind === "cron") {
    return {
      kind: "cron",
      everyAmount: "1",
      everyUnit: "hours",
      at: "",
      cronExpr: job.schedule.expr,
    };
  }

  const everyMs = job.schedule.everyMs;
  if (everyMs % (24 * 60 * 60 * 1000) === 0) {
    return {
      kind: "every",
      everyAmount: String(everyMs / (24 * 60 * 60 * 1000)),
      everyUnit: "days",
      at: "",
      cronExpr: DEFAULT_CHAT_SCHEDULE_DRAFT.cronExpr,
    };
  }
  if (everyMs % (60 * 60 * 1000) === 0) {
    return {
      kind: "every",
      everyAmount: String(everyMs / (60 * 60 * 1000)),
      everyUnit: "hours",
      at: "",
      cronExpr: DEFAULT_CHAT_SCHEDULE_DRAFT.cronExpr,
    };
  }
  return {
    kind: "every",
    everyAmount: String(everyMs / (60 * 1000)),
    everyUnit: "minutes",
    at: "",
    cronExpr: DEFAULT_CHAT_SCHEDULE_DRAFT.cronExpr,
  };
}

export function createChatScheduleDraftFromJob(job: CronJob): ChatScheduleDraft {
  const policy = job.executionPolicy;
  const prompt = job.payload.kind === "agentTurn" ? job.payload.message : job.payload.text;
  const schedule = scheduleDraftParts(job);
  const executionMode = isChatExecutionMode(policy?.executionMode)
    ? policy.executionMode
    : job.payload.kind === "agentTurn"
      ? "agent-turn"
      : "no-model";
  const skillInput = policy?.skillAction?.input;
  const modelPolicy = policy?.modelPolicy;
  const coordination = policy?.coordination;
  const budget = policy?.budget;
  const stop = policy?.stop;
  const evaluator = policy?.evaluator;
  const repairPolicy = policy?.repairPolicy;
  return {
    ...DEFAULT_CHAT_SCHEDULE_DRAFT,
    open: true,
    editingJobId: job.id,
    agentId: job.agentId ?? "",
    name: job.name,
    prompt,
    objective: policy?.objective ?? "",
    successCriteria: policy?.successCriteria ?? "",
    ...schedule,
    deliveryMode: job.delivery?.mode === "announce" ? "channel" : "local",
    executionMode,
    memoryScope: isChatMemoryScope(policy?.memoryScope) ? policy.memoryScope : "session-summary",
    skillScope: isChatSkillScope(policy?.skillScope) ? policy.skillScope : "agent-default",
    allowedSkills: Array.isArray(policy?.allowedSkills) ? policy.allowedSkills.join(", ") : "",
    skillToolName: policy?.skillAction?.toolName ?? "",
    skillToolInputJson: skillInput ? JSON.stringify(skillInput, null, 2) : "",
    plannerStrategy:
      policy?.planner?.strategy === "cheap-model" || policy?.planner?.strategy === "strong-model"
        ? policy.planner.strategy
        : "",
    policyModel:
      modelPolicy?.model ?? (job.payload.kind === "agentTurn" ? (job.payload.model ?? "") : ""),
    modelRole: modelPolicy?.role ?? "",
    escalationModel: modelPolicy?.escalationModel ?? "",
    coordinationMode: coordination?.mode ?? "none",
    coordinationAgents: Array.isArray(coordination?.agents) ? coordination.agents.join(", ") : "",
    coordinationMaxAgents:
      typeof coordination?.maxAgents === "number" ? String(coordination.maxAgents) : "",
    coordinationRequireApproval: coordination?.requireApproval !== false,
    evaluatorEscalateOnSignal: evaluator?.escalateOnSignal !== false,
    evaluatorSignalIncludes:
      evaluator?.signalIncludes?.join(", ") ?? DEFAULT_CHAT_SCHEDULE_DRAFT.evaluatorSignalIncludes,
    evaluatorMaxEscalations:
      typeof evaluator?.maxEscalations === "number"
        ? String(evaluator.maxEscalations)
        : DEFAULT_CHAT_SCHEDULE_DRAFT.evaluatorMaxEscalations,
    repairAutoRetryReplacement: repairPolicy?.autoRetryReplacement !== false,
    repairAutoStopOptionalSources: repairPolicy?.autoStopOptionalSources === true,
    repairMaxAutoRepairsPerRun:
      typeof repairPolicy?.maxAutoRepairsPerRun === "number"
        ? String(repairPolicy.maxAutoRepairsPerRun)
        : DEFAULT_CHAT_SCHEDULE_DRAFT.repairMaxAutoRepairsPerRun,
    repairRequireApprovalForPrimarySource: repairPolicy?.requireApprovalForPrimarySource !== false,
    budgetMaxTokensPerRun: stringifyNumber(budget?.maxTokensPerRun),
    budgetMaxCostUsdPerRun: stringifyNumber(budget?.maxCostUsdPerRun),
    budgetMaxRunsPerHour: stringifyNumber(budget?.maxRunsPerHour),
    stopOnSuccess: stop?.onSuccess === true,
    stopTextIncludes: Array.isArray(stop?.outputIncludes) ? stop.outputIncludes.join(", ") : "",
    stopMaxSuccessfulRuns: stringifyNumber(stop?.maxSuccessfulRuns),
    stopMaxTotalRuns: stringifyNumber(stop?.maxTotalRuns),
  };
}

function buildChatSchedule(draft: ChatScheduleDraft): CronSchedule {
  if (draft.kind === "at") {
    const ms = Date.parse(draft.at);
    if (!Number.isFinite(ms)) {
      throw new Error("Choose a valid run time.");
    }
    return { kind: "at", at: new Date(ms).toISOString() };
  }
  if (draft.kind === "cron") {
    const expr = draft.cronExpr.trim();
    if (!expr) {
      throw new Error("Enter a cron expression.");
    }
    return { kind: "cron", expr };
  }

  const amount = toNumber(draft.everyAmount.trim(), 0);
  const multiplier =
    draft.everyUnit === "days"
      ? 24 * 60 * 60 * 1000
      : draft.everyUnit === "hours"
        ? 60 * 60 * 1000
        : 60 * 1000;
  const everyMs = Math.floor(amount * multiplier);
  if (!Number.isFinite(everyMs) || everyMs <= 0) {
    throw new Error("Enter a positive interval.");
  }
  return { kind: "every", everyMs };
}

function buildChatScheduleExecutionPolicy(draft: ChatScheduleDraft): CronTaskExecutionPolicy {
  const allowedSkills = parseCsvList(draft.allowedSkills);
  const stopTextIncludes = parseCsvList(draft.stopTextIncludes);
  const skillToolName = draft.skillToolName.trim();
  if (draft.executionMode === "skill-only" && !skillToolName) {
    throw new Error("Choose a skill tool for skill-only tasks.");
  }
  const skillInput = parseSkillInputJson(draft.skillToolInputJson);
  const modelPolicy: NonNullable<CronTaskExecutionPolicy["modelPolicy"]> = {
    mode:
      draft.executionMode === "no-model"
        ? "none"
        : draft.policyModel.trim()
          ? "task-override"
          : draft.executionMode === "auto"
            ? "auto"
            : "agent-default",
  };
  if (draft.policyModel.trim()) {
    modelPolicy.model = draft.policyModel.trim();
  }
  if (draft.modelRole) {
    modelPolicy.role = draft.modelRole;
  }
  if (draft.escalationModel.trim()) {
    modelPolicy.escalationModel = draft.escalationModel.trim();
  }

  const budget: NonNullable<CronTaskExecutionPolicy["budget"]> = {};
  const maxTokensPerRun = parseOptionalNonNegativeNumber(draft.budgetMaxTokensPerRun);
  if (maxTokensPerRun !== undefined) {
    budget.maxTokensPerRun = maxTokensPerRun;
  }
  const maxCostUsdPerRun = parseOptionalNonNegativeNumber(draft.budgetMaxCostUsdPerRun);
  if (maxCostUsdPerRun !== undefined) {
    budget.maxCostUsdPerRun = maxCostUsdPerRun;
  }
  const maxRunsPerHour = parseOptionalNonNegativeNumber(draft.budgetMaxRunsPerHour);
  if (maxRunsPerHour !== undefined) {
    budget.maxRunsPerHour = maxRunsPerHour;
  }
  const stop: NonNullable<CronTaskExecutionPolicy["stop"]> = {};
  if (draft.stopOnSuccess) {
    stop.onSuccess = true;
  }
  if (stopTextIncludes.length > 0) {
    stop.outputIncludes = stopTextIncludes;
  }
  const maxSuccessfulRuns = parseOptionalPositiveInteger(draft.stopMaxSuccessfulRuns);
  if (maxSuccessfulRuns !== undefined) {
    stop.maxSuccessfulRuns = maxSuccessfulRuns;
  }
  const maxTotalRuns = parseOptionalPositiveInteger(draft.stopMaxTotalRuns);
  if (maxTotalRuns !== undefined) {
    stop.maxTotalRuns = maxTotalRuns;
  }
  const coordination = buildTaskCoordinationPolicy(draft);
  const planner = buildTaskPlanner(draft);

  return {
    ...(draft.objective.trim() ? { objective: draft.objective.trim() } : {}),
    ...(draft.successCriteria.trim() ? { successCriteria: draft.successCriteria.trim() } : {}),
    triggerKind: "schedule",
    executionMode: draft.executionMode,
    memoryScope: draft.memoryScope,
    skillScope: draft.skillScope,
    ...(allowedSkills.length > 0 ? { allowedSkills } : {}),
    ...(skillToolName
      ? {
          skillAction: {
            toolName: skillToolName,
            ...(skillInput ? { input: skillInput } : {}),
          },
        }
      : {}),
    modelPolicy,
    ...(planner ? { planner } : {}),
    evaluator: buildTaskEvaluatorPolicy(draft),
    repairPolicy: buildTaskRepairPolicy(draft),
    ...(coordination ? { coordination } : {}),
    ...(Object.keys(budget).length > 0 ? { budget } : {}),
    ...(Object.keys(stop).length > 0 ? { stop } : {}),
  };
}

export function buildChatScheduleCronAddParams(input: ChatScheduleCronInput) {
  const name = input.draft.name.trim() || deriveChatScheduleName(input.draft.prompt);
  const message = input.draft.prompt.trim();
  const agentId = input.agentId.trim();
  const sessionKey = input.sessionKey.trim();
  if (!message) {
    throw new Error("Enter a prompt to schedule.");
  }
  if (!agentId) {
    throw new Error("Choose an Agent before scheduling.");
  }
  if (!sessionKey) {
    throw new Error("Choose a session before scheduling.");
  }
  return {
    name,
    description: "",
    agentId,
    sessionKey,
    enabled: true,
    schedule: buildChatSchedule(input.draft),
    sessionTarget: "isolated" as const,
    wakeMode: "next-heartbeat" as const,
    payload: {
      kind: "agentTurn" as const,
      message,
    },
    delivery: input.delivery,
    executionPolicy: buildChatScheduleExecutionPolicy(input.draft),
  };
}

export function buildChatScheduleCronUpdateParams(input: ChatScheduleCronUpdateInput) {
  const jobId = input.jobId.trim();
  if (!jobId) {
    throw new Error("Choose a task to update.");
  }
  const patch = buildChatScheduleCronAddParams({
    ...input,
    delivery: input.delivery ?? ({ mode: "none" } as const),
  });
  return {
    id: jobId,
    patch: {
      ...patch,
      enabled: input.existingJob?.enabled ?? patch.enabled,
    },
  };
}

export async function addChatScheduleTask(state: CronState, input: ChatScheduleCronInput) {
  if (!state.client || !state.connected) {
    throw new Error("Gateway is not connected.");
  }
  if (state.cronBusy) {
    throw new Error("Another task action is already running.");
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.add", buildChatScheduleCronAddParams(input));
    await loadCronJobs(state);
    await loadCronStatus(state);
  } catch (err) {
    state.cronError = String(err);
    throw err;
  } finally {
    state.cronBusy = false;
  }
}

export async function updateChatScheduleTask(state: CronState, input: ChatScheduleCronUpdateInput) {
  if (!state.client || !state.connected) {
    throw new Error("Gateway is not connected.");
  }
  if (state.cronBusy) {
    throw new Error("Another task action is already running.");
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.update", buildChatScheduleCronUpdateParams(input));
    await loadCronJobs(state);
    await loadCronStatus(state);
  } catch (err) {
    state.cronError = String(err);
    throw err;
  } finally {
    state.cronBusy = false;
  }
}

export function startCronEdit(state: CronState, job: CronJob) {
  state.cronEditingJobId = job.id;
  state.cronRunsJobId = job.id;
  state.cronForm = cronJobToForm(job, state.cronForm);
  state.cronFieldErrors = validateCronForm(state.cronForm);
}

function buildCloneName(name: string, existingNames: Set<string>) {
  const base = name.trim() || "Job";
  const first = `${base} copy`;
  if (!existingNames.has(first.toLowerCase())) {
    return first;
  }
  let index = 2;
  while (index < 1000) {
    const next = `${base} copy ${index}`;
    if (!existingNames.has(next.toLowerCase())) {
      return next;
    }
    index += 1;
  }
  return `${base} copy ${Date.now()}`;
}

export function startCronClone(state: CronState, job: CronJob) {
  clearCronEditState(state);
  state.cronRunsJobId = job.id;
  const existingNames = new Set(state.cronJobs.map((entry) => entry.name.trim().toLowerCase()));
  const cloned = cronJobToForm(job, state.cronForm);
  cloned.name = buildCloneName(job.name, existingNames);
  state.cronForm = cloned;
  state.cronFieldErrors = validateCronForm(state.cronForm);
}

export function cancelCronEdit(state: CronState) {
  clearCronEditState(state);
  resetCronFormToDefaults(state);
}
