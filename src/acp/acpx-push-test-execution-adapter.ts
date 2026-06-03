import { WRITE_SCOPE, authorizeOperatorScopesForMethod } from "../gateway/method-scopes.js";
import { consumeMutatingAdminRpcBudget } from "../gateway/mutating-admin-rpc-rate-limit.js";
import type { ErrorShape } from "../gateway/protocol/index.js";
import { logMutatingAdminRpcAudit } from "../gateway/server-methods/mutating-admin-rpc-audit.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
} from "../gateway/server-methods/types.js";
import {
  ACPX_PUSH_TEST_METHOD,
  ACPX_PUSH_TEST_WRAPPER_ID,
  createAcpxPushTestSafeSummary,
  evaluateAcpxPushTestApprovalContract,
  type AcpxPushTestApprovalContractRequest,
  type AcpxPushTestApprovalContractResponse,
} from "./acpx-push-test-approval-contract.js";

export type AcpxPushTestExecutionGate = {
  enabled: boolean;
  allowExecution: boolean;
  gatewayHandlerRegistered: boolean;
};

export type AcpxPushTestExecutionAdapterInput = {
  request: AcpxPushTestApprovalContractRequest;
  executionGate: AcpxPushTestExecutionGate;
  handler?: GatewayRequestHandler;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect?: GatewayRequestHandlerOptions["isWebchatConnect"];
};

export type AcpxPushTestExecutionAdapterResult = {
  schemaVersion: 1;
  kind: "acpx.mutating-wrapper.push-test.execution.result";
  wrapperId: typeof ACPX_PUSH_TEST_WRAPPER_ID;
  method: typeof ACPX_PUSH_TEST_METHOD;
  requestId: string;
  status: "executed" | "denied" | "failed";
  executionPerformed: boolean;
  noGenericDispatcher: true;
  contract: AcpxPushTestApprovalContractResponse;
  reasons: string[];
  safeSummary: AcpxPushTestApprovalContractResponse["safeSummary"];
  result?: {
    ok?: boolean;
    status?: number;
    reason?: string;
    environment?: string;
    apnsId?: string;
    tokenSuffix?: string;
    topic?: string;
  };
  error?: {
    code?: ErrorShape["code"];
    message: string;
  };
};

type HandlerResponse = {
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};

function sanitizePushResult(payload: unknown): AcpxPushTestExecutionAdapterResult["result"] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  return {
    ok: typeof record.ok === "boolean" ? record.ok : undefined,
    status: typeof record.status === "number" ? record.status : undefined,
    reason: typeof record.reason === "string" ? record.reason : undefined,
    environment: typeof record.environment === "string" ? record.environment : undefined,
    apnsId: typeof record.apnsId === "string" ? record.apnsId : undefined,
    tokenSuffix: typeof record.tokenSuffix === "string" ? record.tokenSuffix : undefined,
    topic: typeof record.topic === "string" ? record.topic : undefined,
  };
}

function collectExecutionGateReasons(input: AcpxPushTestExecutionAdapterInput): string[] {
  const reasons: string[] = [];
  if (!input.executionGate.enabled) {
    reasons.push("ACPX push-test execution adapter is disabled");
  }
  if (!input.executionGate.allowExecution) {
    reasons.push("ACPX push-test execution is not explicitly enabled");
  }
  if (!input.executionGate.gatewayHandlerRegistered || !input.handler) {
    reasons.push("ACPX push-test gateway handler is not registered");
  }
  const role = input.client?.connect?.role ?? "operator";
  if (!input.client?.connect || role !== "operator") {
    reasons.push("ACPX push-test execution requires an operator client");
  } else {
    const scopes = input.client.connect.scopes ?? [];
    const auth = authorizeOperatorScopesForMethod(ACPX_PUSH_TEST_METHOD, scopes);
    if (!auth.allowed) {
      reasons.push(`ACPX push-test execution requires ${auth.missingScope}`);
    }
  }
  return reasons;
}

function deniedResult(params: {
  input: AcpxPushTestExecutionAdapterInput;
  contract: AcpxPushTestApprovalContractResponse;
  reasons: string[];
}): AcpxPushTestExecutionAdapterResult {
  logMutatingAdminRpcAudit({
    context: params.input.context,
    client: params.input.client,
    method: ACPX_PUSH_TEST_METHOD,
    outcome: "denied",
    details: {
      wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
      requestId: params.input.request.requestId,
      reason: params.reasons.join("|"),
    },
  });
  return {
    schemaVersion: 1,
    kind: "acpx.mutating-wrapper.push-test.execution.result",
    wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
    method: ACPX_PUSH_TEST_METHOD,
    requestId: params.input.request.requestId,
    status: "denied",
    executionPerformed: false,
    noGenericDispatcher: true,
    contract: params.contract,
    reasons: params.reasons,
    safeSummary: createAcpxPushTestSafeSummary(params.input.request.params),
  };
}

async function invokePushTestHandler(
  input: AcpxPushTestExecutionAdapterInput & { handler: GatewayRequestHandler },
): Promise<HandlerResponse> {
  return await new Promise<HandlerResponse>((resolve, reject) => {
    let responded = false;
    const respond: GatewayRequestHandlerOptions["respond"] = (ok, payload, error) => {
      responded = true;
      resolve({ ok, payload, error });
    };
    Promise.resolve(
      input.handler({
        req: {
          type: "req",
          id: `acpx-push-test:${input.request.requestId}`,
          method: ACPX_PUSH_TEST_METHOD,
          params: input.request.params,
        },
        params: input.request.params,
        client: input.client,
        context: input.context,
        isWebchatConnect: input.isWebchatConnect ?? (() => false),
        respond,
      }),
    ).then(
      () => {
        if (!responded) {
          resolve({ ok: true, payload: undefined });
        }
      },
      (err) => reject(err),
    );
  });
}

export async function executeAcpxPushTestRequest(
  input: AcpxPushTestExecutionAdapterInput,
): Promise<AcpxPushTestExecutionAdapterResult> {
  const contract = evaluateAcpxPushTestApprovalContract(input.request);
  if (contract.status !== "admitted") {
    return deniedResult({
      input,
      contract,
      reasons: contract.reasons,
    });
  }

  const executionGateReasons = collectExecutionGateReasons(input);
  if (executionGateReasons.length > 0) {
    return deniedResult({
      input,
      contract,
      reasons: executionGateReasons,
    });
  }

  const budget = consumeMutatingAdminRpcBudget({
    method: ACPX_PUSH_TEST_METHOD,
    client: input.client,
  });
  if (budget.applies && !budget.allowed) {
    return deniedResult({
      input,
      contract,
      reasons: [`ACPX push-test execution rate-limited:${budget.policy.label}`],
    });
  }

  try {
    const response = await invokePushTestHandler({
      ...input,
      handler: input.handler as GatewayRequestHandler,
    });
    if (!response.ok) {
      return {
        schemaVersion: 1,
        kind: "acpx.mutating-wrapper.push-test.execution.result",
        wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
        method: ACPX_PUSH_TEST_METHOD,
        requestId: input.request.requestId,
        status: "failed",
        executionPerformed: true,
        noGenericDispatcher: true,
        contract,
        reasons: [response.error?.message ?? "push.test handler failed"],
        safeSummary: createAcpxPushTestSafeSummary(input.request.params),
        error: {
          code: response.error?.code,
          message: response.error?.message ?? "push.test handler failed",
        },
      };
    }

    return {
      schemaVersion: 1,
      kind: "acpx.mutating-wrapper.push-test.execution.result",
      wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
      method: ACPX_PUSH_TEST_METHOD,
      requestId: input.request.requestId,
      status: "executed",
      executionPerformed: true,
      noGenericDispatcher: true,
      contract,
      reasons: [],
      safeSummary: createAcpxPushTestSafeSummary(input.request.params),
      result: sanitizePushResult(response.payload),
    };
  } catch (err) {
    logMutatingAdminRpcAudit({
      context: input.context,
      client: input.client,
      method: ACPX_PUSH_TEST_METHOD,
      outcome: "failed",
      details: {
        wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
        requestId: input.request.requestId,
        reason: "handler_threw",
      },
    });
    return {
      schemaVersion: 1,
      kind: "acpx.mutating-wrapper.push-test.execution.result",
      wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
      method: ACPX_PUSH_TEST_METHOD,
      requestId: input.request.requestId,
      status: "failed",
      executionPerformed: true,
      noGenericDispatcher: true,
      contract,
      reasons: [err instanceof Error ? err.message : "push.test handler failed"],
      safeSummary: createAcpxPushTestSafeSummary(input.request.params),
      error: {
        message: err instanceof Error ? err.message : "push.test handler failed",
      },
    };
  }
}

export const ACPX_PUSH_TEST_EXECUTION_REQUIRED_OPERATOR_SCOPE = WRITE_SCOPE;
