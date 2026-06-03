import { spawnSubagentDirect } from "../agents/subagent-spawn.js";
import type { CronGraphNodeHandlerResult, CronTaskGraphContextItem } from "./graph-context.js";
import type { DeliveryTargetResolution } from "./isolated-agent/delivery-target.js";
import {
  readDescendantSubagentFallbackReply,
  waitForDescendantSubagentSummary,
} from "./isolated-agent/subagent-followup.js";
import type { CronJob, CronTaskCoordinationEvidence, CronTaskCoordinationMode } from "./types.js";

type SpawnSubagent = typeof spawnSubagentDirect;
type WaitForSummary = typeof waitForDescendantSubagentSummary;
type ReadFallbackReply = typeof readDescendantSubagentFallbackReply;

export type CronTaskCoordinationDeps = {
  spawnSubagent?: SpawnSubagent;
  waitForSummary?: WaitForSummary;
  readFallbackReply?: ReadFallbackReply;
  nowMs?: () => number;
};

export type RunCronTaskCoordinationNodeParams = {
  job: CronJob;
  message: string;
  nodeId: string;
  agentId: string;
  agentSessionKey: string;
  graphContext: CronTaskGraphContextItem[];
  resolvedDelivery: DeliveryTargetResolution;
  abortSignal?: AbortSignal;
};

function uniqueTrimmed(values: string[] | undefined) {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function selectedCoordinationAgents(job: CronJob) {
  const pendingAgents = uniqueTrimmed(job.state.pendingCoordination?.agents);
  if (pendingAgents.length > 0) {
    return pendingAgents;
  }
  const coordination = job.executionPolicy?.coordination;
  const agents = uniqueTrimmed(coordination?.agents);
  if (agents.length === 0) {
    return [];
  }
  const maxAgents =
    typeof coordination?.maxAgents === "number" && Number.isFinite(coordination.maxAgents)
      ? Math.max(1, Math.floor(coordination.maxAgents))
      : agents.length;
  return agents.slice(0, maxAgents);
}

function graphEvidenceContext(context: CronTaskGraphContextItem[]) {
  return context
    .filter((entry) => entry.summary?.trim() || entry.outputText?.trim() || entry.error?.trim())
    .slice(-8)
    .map((entry) => {
      const label = entry.label?.trim() || entry.nodeId;
      const status = entry.status ? ` (${entry.status})` : "";
      const body = entry.outputText?.trim() || entry.summary?.trim() || entry.error?.trim() || "";
      return `### ${label}${status}\n${body}`.trim();
    })
    .join("\n\n");
}

function buildCoordinationTaskPrompt(params: {
  job: CronJob;
  message: string;
  nodeId: string;
  mode: CronTaskCoordinationMode;
  graphContext: CronTaskGraphContextItem[];
}) {
  const context = graphEvidenceContext(params.graphContext);
  const pending = params.job.state.pendingCoordination;
  const prompt = [
    `Task-room ${params.mode} request.`,
    `Owning task: ${params.job.name || params.job.id}`,
    `Task id: ${params.job.id}`,
    `Graph node: ${params.nodeId}`,
    pending?.reason ? `Coordination request: ${pending.reason}` : undefined,
    "",
    "Review the task and return concise evidence, risks, or advice for the owner Agent.",
    "Do not take external action unless the task explicitly asks for it and your policy allows it.",
    "",
    "Task prompt:",
    params.message,
    context ? `\nExisting task graph evidence:\n${context}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
    .trim();
  return prompt;
}

function formatEvidenceOutput(evidence: CronTaskCoordinationEvidence[], summary?: string) {
  const lines = evidence.map((entry) => {
    const session = entry.childSessionKey ? ` · session ${entry.childSessionKey}` : "";
    const run = entry.runId ? ` · run ${entry.runId}` : "";
    const error = entry.error ? ` · ${entry.error}` : "";
    return `- ${entry.agentId}: ${entry.status}${session}${run}${error}`;
  });
  return [
    "Task-room evidence",
    ...lines,
    summary?.trim() ? `\nCoordinator summary:\n${summary.trim()}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export async function runCronTaskCoordinationNode(
  params: RunCronTaskCoordinationNodeParams,
  deps: CronTaskCoordinationDeps = {},
): Promise<CronGraphNodeHandlerResult> {
  const coordination = params.job.executionPolicy?.coordination;
  const mode = params.job.state.pendingCoordination?.mode ?? coordination?.mode ?? "none";
  const nowMs = deps.nowMs ?? (() => Date.now());
  const createdAtMs = nowMs();
  const agents = selectedCoordinationAgents(params.job);
  if (
    (!coordination && !params.job.state.pendingCoordination) ||
    mode === "none" ||
    agents.length === 0
  ) {
    return {
      status: "skipped",
      summary: "No coordination Agents selected.",
      coordinationEvidence: [
        {
          agentId: "none",
          mode,
          status: "skipped",
          summary: "No coordination Agents selected.",
          createdAtMs,
        },
      ],
    };
  }

  const approvalRequired = coordination?.requireApproval !== false;
  const approved =
    !approvalRequired ||
    (typeof params.job.state.coordinationApprovedAtMs === "number" &&
      Number.isFinite(params.job.state.coordinationApprovedAtMs));
  if (!approved) {
    const evidence = agents.map((agentId) => ({
      agentId,
      mode,
      status: "needs_approval" as const,
      summary: "Coordination requires approval before spawning this Agent.",
      createdAtMs,
    }));
    return {
      status: "skipped",
      summary: "Coordination approval required; no Agents were spawned.",
      outputText: formatEvidenceOutput(evidence),
      coordinationEvidence: evidence,
    };
  }

  if (params.abortSignal?.aborted) {
    return {
      status: "error",
      error: "Task coordination was canceled before Agents were spawned.",
      coordinationEvidence: [],
    };
  }

  const spawn = deps.spawnSubagent ?? spawnSubagentDirect;
  const waitForSummary = deps.waitForSummary ?? waitForDescendantSubagentSummary;
  const readFallbackReply = deps.readFallbackReply ?? readDescendantSubagentFallbackReply;
  const task = buildCoordinationTaskPrompt({
    job: params.job,
    message: params.message,
    nodeId: params.nodeId,
    mode,
    graphContext: params.graphContext,
  });
  const spawnStartedAt = nowMs();
  const spawnResults = await Promise.all(
    agents.map(async (agentId): Promise<CronTaskCoordinationEvidence> => {
      const result = await spawn(
        {
          task,
          label: `${params.job.name || params.job.id} coordination`,
          agentId,
          mode: "run",
          cleanup: "keep",
          expectsCompletionMessage: true,
        },
        {
          agentSessionKey: params.agentSessionKey,
          agentChannel: params.resolvedDelivery.ok ? params.resolvedDelivery.channel : undefined,
          agentAccountId: params.resolvedDelivery.accountId,
          agentTo: params.resolvedDelivery.to,
          agentThreadId: params.resolvedDelivery.threadId,
          requesterAgentIdOverride: params.agentId,
          approvedTargetAgentIds: agents,
        },
      );
      if (result.status === "accepted") {
        return {
          agentId,
          mode,
          status: "accepted",
          childSessionKey: result.childSessionKey,
          runId: result.runId,
          summary: result.note,
          createdAtMs: nowMs(),
        };
      }
      return {
        agentId,
        mode,
        status: result.status === "forbidden" ? "forbidden" : "error",
        childSessionKey: result.childSessionKey,
        runId: result.runId,
        error: result.error,
        createdAtMs: nowMs(),
      };
    }),
  );

  const accepted = spawnResults.some((entry) => entry.status === "accepted");
  const summary = accepted
    ? ((await waitForSummary({
        sessionKey: params.agentSessionKey,
        timeoutMs: 30_000,
        observedActiveDescendants: true,
      })) ??
      (await readFallbackReply({
        sessionKey: params.agentSessionKey,
        runStartedAt: spawnStartedAt,
      })))
    : undefined;
  const completedEvidence =
    summary && accepted
      ? spawnResults.map((entry) =>
          entry.status === "accepted"
            ? {
                ...entry,
                status: "completed" as const,
                outputText: summary,
              }
            : entry,
        )
      : spawnResults;
  const outputText = formatEvidenceOutput(completedEvidence, summary);
  return {
    status: accepted ? "ok" : "skipped",
    summary: accepted
      ? summary?.trim() || `Consulted ${spawnResults.length} coordination Agent(s).`
      : "No coordination Agent accepted the task.",
    outputText,
    coordinationEvidence: completedEvidence,
  };
}

export const __testing = {
  buildCoordinationTaskPrompt,
  selectedCoordinationAgents,
};
