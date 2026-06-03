import type { SystemRunApprovalPlanV2 } from "../infra/exec-approvals.js";
import { buildSystemRunApprovalPlanV2 } from "../node-host/invoke-system-run-plan.js";

export function buildSystemRunPreparePayload(params: {
  command?: unknown;
  rawCommand?: unknown;
  cwd?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
}): { payload: { cmdText: string; plan: SystemRunApprovalPlanV2 } } {
  const prepared = buildSystemRunApprovalPlanV2(params);
  if (!prepared.ok) {
    throw new Error(prepared.message);
  }
  return {
    payload: {
      cmdText: prepared.cmdText,
      plan: prepared.plan,
    },
  };
}
