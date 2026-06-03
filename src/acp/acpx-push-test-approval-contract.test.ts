import { describe, expect, it } from "vitest";
import type { AcpxMutatingWrapperGate } from "./acpx-mutating-wrapper-policy.js";
import {
  ACPX_PUSH_TEST_METHOD,
  ACPX_PUSH_TEST_WRAPPER_ID,
  createAcpxPushTestRequestFingerprint,
  evaluateAcpxPushTestApprovalContract,
  type AcpxPushTestApprovalContractRequest,
} from "./acpx-push-test-approval-contract.js";

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

describe("ACPX push-test approval contract", () => {
  it("admits only the fixed push-test wrapper after approval and runtime gates pass", () => {
    const response = evaluateAcpxPushTestApprovalContract(baseRequest());

    expect(response).toMatchObject({
      wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
      method: "push.test",
      dryRun: true,
      noExecutionPerformed: true,
      status: "admitted",
      stage: "admitted",
      reasons: [],
      safeSummary: {
        nodeId: "ios-node-1",
        environment: "sandbox",
        titleProvided: true,
        bodyProvided: true,
      },
      gate: {
        allowed: true,
        reason: "allowed",
      },
    });
  });

  it("denies unsupported wrappers before operator approval or runtime gates matter", () => {
    const response = evaluateAcpxPushTestApprovalContract(
      baseRequest({
        wrapperId: "fased_chat_inject_request" as typeof ACPX_PUSH_TEST_WRAPPER_ID,
        method: "chat.inject" as typeof ACPX_PUSH_TEST_METHOD,
      }),
    );

    expect(response).toMatchObject({
      status: "denied",
      stage: "request",
      reasons: [
        "ACPX push-test execution request wrapper is unsupported",
        "ACPX push-test execution request method is unsupported",
      ],
    });
  });

  it("denies invalid push params", () => {
    const response = evaluateAcpxPushTestApprovalContract(
      baseRequest({
        params: {
          nodeId: "",
        },
      }),
    );

    expect(response).toMatchObject({
      status: "denied",
      stage: "request",
      reasons: ["ACPX push-test execution request params are invalid"],
    });
  });

  it("requires explicit operator approval bound to the exact request fingerprint", () => {
    expect(
      evaluateAcpxPushTestApprovalContract(
        baseRequest({
          approval: {
            confirmation: "none",
          },
        }),
      ),
    ).toMatchObject({
      status: "denied",
      stage: "operator-approval",
      reasons: [
        "ACPX push-test execution requires explicit operator confirmation",
        "ACPX push-test approval fingerprint does not match request",
      ],
    });

    expect(
      evaluateAcpxPushTestApprovalContract(
        baseRequest({
          approval: {
            confirmation: "operator-confirmed",
            acceptedRequestFingerprint: "wrong-fingerprint",
            approvedAt: "2026-05-01T00:00:01.000Z",
          },
        }),
      ),
    ).toMatchObject({
      status: "denied",
      stage: "operator-approval",
      reasons: ["ACPX push-test approval fingerprint does not match request"],
    });
  });

  it("denies when the runtime gate is not admitted", () => {
    const gate = {
      gates: allRequiredGateState(),
      allowWrappers: [ACPX_PUSH_TEST_WRAPPER_ID],
      forbiddenSurfaces: {
        "client-supplied-mcpServers": true,
      },
    };
    const response = evaluateAcpxPushTestApprovalContract(baseRequest({ gate }));

    expect(response).toMatchObject({
      status: "denied",
      stage: "runtime-gate",
      reasons: ["mutating wrapper runtime gate denied: forbidden-surface"],
      gate: {
        allowed: false,
        reason: "forbidden-surface",
        activeForbiddenSurfaces: ["client-supplied-mcpServers"],
      },
    });
  });

  it("does not leak push title or body through the approval response", () => {
    const response = evaluateAcpxPushTestApprovalContract(
      baseRequest({
        params: {
          nodeId: "ios-node-1",
          title: "do-not-leak-title",
          body: "do-not-leak-body",
          environment: "production",
        },
      }),
    );
    const serialized = JSON.stringify(response);

    expect(serialized).not.toContain("do-not-leak-title");
    expect(serialized).not.toContain("do-not-leak-body");
    expect(response.safeSummary).toEqual({
      nodeId: "ios-node-1",
      environment: "production",
      titleProvided: true,
      bodyProvided: true,
    });
  });
});
