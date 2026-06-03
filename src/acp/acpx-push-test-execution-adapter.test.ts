import { beforeEach, describe, expect, it, vi } from "vitest";
import { __testing as mutatingAdminRateLimitTesting } from "../gateway/mutating-admin-rpc-rate-limit.js";
import { ErrorCodes } from "../gateway/protocol/index.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandler,
} from "../gateway/server-methods/types.js";
import type { AcpxMutatingWrapperGate } from "./acpx-mutating-wrapper-policy.js";
import {
  ACPX_PUSH_TEST_METHOD,
  ACPX_PUSH_TEST_WRAPPER_ID,
  createAcpxPushTestRequestFingerprint,
  type AcpxPushTestApprovalContractRequest,
} from "./acpx-push-test-approval-contract.js";
import { executeAcpxPushTestRequest } from "./acpx-push-test-execution-adapter.js";

const ALL_REQUIRED_GATES: AcpxMutatingWrapperGate[] = [
  "operator-scope",
  "operator-confirmation",
  "plugin-admin-rpc-grant",
  "plugin-source-allowlist",
  "audit",
  "rate-limit",
  "gateway-token",
  "explicit-wrapper-enable",
];

function allRequiredGateState(): Record<AcpxMutatingWrapperGate, boolean> {
  return Object.fromEntries(ALL_REQUIRED_GATES.map((gate) => [gate, true])) as Record<
    AcpxMutatingWrapperGate,
    boolean
  >;
}

function makeContext() {
  return {
    logGateway: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as GatewayRequestContext;
}

function makeOperatorClient(scopes: string[] = ["operator.write"]): GatewayClient {
  return {
    connId: "conn-acpx",
    clientIp: "127.0.0.1",
    connect: {
      role: "operator",
      scopes,
      client: { id: "acpx-operator" },
      device: { id: "operator-laptop" },
    },
  } as unknown as GatewayClient;
}

function baseRequest(
  overrides: Partial<AcpxPushTestApprovalContractRequest> = {},
): AcpxPushTestApprovalContractRequest {
  const params = overrides.params ?? {
    nodeId: "ios-node-1",
    title: "secret title",
    body: "secret body",
    environment: "sandbox",
  };
  const request = {
    schemaVersion: 1,
    kind: "acpx.mutating-wrapper.push-test.execution.request",
    wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
    method: ACPX_PUSH_TEST_METHOD,
    dryRun: true,
    requestId: "req-1",
    createdAt: "2026-05-01T00:00:00.000Z",
    params,
    approval: {
      confirmation: "none",
    },
    gate: {
      gates: allRequiredGateState(),
      allowWrappers: [ACPX_PUSH_TEST_WRAPPER_ID],
    },
    ...overrides,
  } satisfies AcpxPushTestApprovalContractRequest;
  const fingerprint = createAcpxPushTestRequestFingerprint({
    wrapperId: request.wrapperId,
    method: request.method,
    params: request.params,
  });
  return {
    ...request,
    approval:
      overrides.approval ??
      ({
        confirmation: "operator-confirmed",
        acceptedRequestFingerprint: fingerprint,
        operatorId: "operator-1",
        approvedAt: "2026-05-01T00:00:01.000Z",
      } as const),
  };
}

function executionGate() {
  return {
    enabled: true,
    allowExecution: true,
    gatewayHandlerRegistered: true,
  };
}

function makeSuccessHandler(): GatewayRequestHandler {
  return vi.fn(async ({ params, respond }) => {
    respond(true, {
      ok: true,
      status: 200,
      environment: params.environment,
      tokenSuffix: "1234abcd",
      topic: "ai.fased.ios",
      title: "do-not-leak-title",
      body: "do-not-leak-body",
    });
  });
}

describe("ACPX push-test execution adapter", () => {
  beforeEach(() => {
    mutatingAdminRateLimitTesting.resetMutatingAdminRpcRateLimitState();
  });

  it("executes only the fixed push-test wrapper after contract, gate, scope, and rate limit admit it", async () => {
    const handler = makeSuccessHandler();
    const request = baseRequest();
    const result = await executeAcpxPushTestRequest({
      request,
      executionGate: executionGate(),
      handler,
      context: makeContext(),
      client: makeOperatorClient(),
    });

    expect(result).toMatchObject({
      wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
      method: "push.test",
      status: "executed",
      executionPerformed: true,
      noGenericDispatcher: true,
      reasons: [],
      result: {
        ok: true,
        status: 200,
        environment: "sandbox",
        tokenSuffix: "1234abcd",
        topic: "ai.fased.ios",
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        params: request.params,
        req: expect.objectContaining({
          method: "push.test",
        }),
      }),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret title");
    expect(serialized).not.toContain("secret body");
    expect(serialized).not.toContain("do-not-leak-title");
    expect(serialized).not.toContain("do-not-leak-body");
  });

  it("does not call the handler when the approval contract is denied", async () => {
    const handler = makeSuccessHandler();
    const result = await executeAcpxPushTestRequest({
      request: baseRequest({
        approval: {
          confirmation: "none",
        },
      }),
      executionGate: executionGate(),
      handler,
      context: makeContext(),
      client: makeOperatorClient(),
    });

    expect(result).toMatchObject({
      status: "denied",
      executionPerformed: false,
      reasons: expect.arrayContaining([
        "ACPX push-test execution requires explicit operator confirmation",
      ]),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires explicit execution enablement and a registered fixed handler", async () => {
    const handler = makeSuccessHandler();
    await expect(
      executeAcpxPushTestRequest({
        request: baseRequest(),
        executionGate: {
          enabled: true,
          allowExecution: false,
          gatewayHandlerRegistered: true,
        },
        handler,
        context: makeContext(),
        client: makeOperatorClient(),
      }),
    ).resolves.toMatchObject({
      status: "denied",
      executionPerformed: false,
      reasons: ["ACPX push-test execution is not explicitly enabled"],
    });

    await expect(
      executeAcpxPushTestRequest({
        request: baseRequest(),
        executionGate: {
          enabled: true,
          allowExecution: true,
          gatewayHandlerRegistered: false,
        },
        context: makeContext(),
        client: makeOperatorClient(),
      }),
    ).resolves.toMatchObject({
      status: "denied",
      executionPerformed: false,
      reasons: ["ACPX push-test gateway handler is not registered"],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires an operator client with write scope", async () => {
    const handler = makeSuccessHandler();
    const result = await executeAcpxPushTestRequest({
      request: baseRequest(),
      executionGate: executionGate(),
      handler,
      context: makeContext(),
      client: makeOperatorClient(["operator.read"]),
    });

    expect(result).toMatchObject({
      status: "denied",
      executionPerformed: false,
      reasons: ["ACPX push-test execution requires operator.write"],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("inherits mutating admin RPC rate limits before handler execution", async () => {
    const handler = makeSuccessHandler();
    const call = {
      request: baseRequest(),
      executionGate: executionGate(),
      handler,
      context: makeContext(),
      client: makeOperatorClient(),
    };

    await executeAcpxPushTestRequest(call);
    await executeAcpxPushTestRequest(call);
    await executeAcpxPushTestRequest(call);
    const blocked = await executeAcpxPushTestRequest(call);

    expect(handler).toHaveBeenCalledTimes(3);
    expect(blocked).toMatchObject({
      status: "denied",
      executionPerformed: false,
      reasons: ["ACPX push-test execution rate-limited:3 per 60s"],
    });
  });

  it("reports handler failures without reclassifying them as successful execution", async () => {
    const handler = vi.fn(async ({ respond }) => {
      respond(false, undefined, {
        code: ErrorCodes.INVALID_REQUEST,
        message: "node has no APNs registration",
      });
    });
    const result = await executeAcpxPushTestRequest({
      request: baseRequest(),
      executionGate: executionGate(),
      handler,
      context: makeContext(),
      client: makeOperatorClient(),
    });

    expect(result).toMatchObject({
      status: "failed",
      executionPerformed: true,
      reasons: ["node has no APNs registration"],
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: "node has no APNs registration",
      },
    });
  });
});
