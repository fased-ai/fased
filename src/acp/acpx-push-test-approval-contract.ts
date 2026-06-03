import { createHash } from "node:crypto";
import { validatePushTestParams } from "../gateway/protocol/index.js";
import type { PushTestParams } from "../gateway/protocol/schema/types.js";
import {
  evaluateAcpxMutatingWrapperRuntimeGate,
  type AcpxMutatingWrapperGateState,
  type AcpxMutatingWrapperForbiddenSurfaceState,
  type AcpxMutatingWrapperRuntimeGateDecision,
} from "./acpx-mutating-wrapper-policy.js";

export const ACPX_PUSH_TEST_WRAPPER_ID = "fased_push_test_request";
export const ACPX_PUSH_TEST_METHOD = "push.test";

export type AcpxPushTestApprovalContractSchemaVersion = 1;

export type AcpxPushTestOperatorApproval =
  | {
      confirmation: "none";
      acceptedRequestFingerprint?: string;
      operatorId?: string;
      approvedAt?: string;
    }
  | {
      confirmation: "operator-confirmed";
      acceptedRequestFingerprint: string;
      operatorId?: string;
      approvedAt: string;
    };

export type AcpxPushTestApprovalContractRequest = {
  schemaVersion: AcpxPushTestApprovalContractSchemaVersion;
  kind: "acpx.mutating-wrapper.push-test.execution.request";
  wrapperId: typeof ACPX_PUSH_TEST_WRAPPER_ID;
  method: typeof ACPX_PUSH_TEST_METHOD;
  dryRun: true;
  requestId: string;
  createdAt: string;
  params: PushTestParams;
  approval: AcpxPushTestOperatorApproval;
  gate: {
    gates?: AcpxMutatingWrapperGateState;
    forbiddenSurfaces?: AcpxMutatingWrapperForbiddenSurfaceState;
    allowWrappers?: readonly string[];
    denyWrappers?: readonly string[];
  };
};

export type AcpxPushTestApprovalContractResponseStage =
  | "request"
  | "operator-approval"
  | "runtime-gate"
  | "admitted";

export type AcpxPushTestApprovalContractResponse = {
  schemaVersion: AcpxPushTestApprovalContractSchemaVersion;
  kind: "acpx.mutating-wrapper.push-test.execution.response";
  wrapperId: typeof ACPX_PUSH_TEST_WRAPPER_ID;
  method: typeof ACPX_PUSH_TEST_METHOD;
  dryRun: true;
  noExecutionPerformed: true;
  requestId: string;
  createdAt: string;
  status: "admitted" | "denied";
  stage: AcpxPushTestApprovalContractResponseStage;
  requestFingerprint: string;
  reasons: string[];
  safeSummary: {
    nodeId: string | null;
    environment: "sandbox" | "production" | null;
    titleProvided: boolean;
    bodyProvided: boolean;
  };
  gate?: AcpxMutatingWrapperRuntimeGateDecision;
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function normalizeForStableJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForStableJson(entry));
  }
  if (typeof value === "object" && value) {
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        normalized[key] = normalizeForStableJson(entry);
      }
    }
    return normalized;
  }
  return null;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

export function createAcpxPushTestRequestFingerprint(input: {
  wrapperId: string;
  method: string;
  params: unknown;
}): string {
  return createHash("sha256")
    .update(
      stableJson({
        method: input.method,
        params: input.params,
        wrapperId: input.wrapperId,
      }),
    )
    .digest("hex");
}

export function createAcpxPushTestSafeSummary(
  params: unknown,
): AcpxPushTestApprovalContractResponse["safeSummary"] {
  const record =
    typeof params === "object" && params !== null && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const environment =
    record.environment === "sandbox" || record.environment === "production"
      ? record.environment
      : null;
  return {
    nodeId: typeof record.nodeId === "string" && record.nodeId.trim() ? record.nodeId.trim() : null,
    environment,
    titleProvided: typeof record.title === "string" && record.title.length > 0,
    bodyProvided: typeof record.body === "string" && record.body.length > 0,
  };
}

export function evaluateAcpxPushTestApprovalContract(
  request: AcpxPushTestApprovalContractRequest,
): AcpxPushTestApprovalContractResponse {
  const requestFingerprint = createAcpxPushTestRequestFingerprint({
    wrapperId: request.wrapperId,
    method: request.method,
    params: request.params,
  });
  const requestReasons = collectRequestDenyReasons(request);
  if (requestReasons.length > 0) {
    return deniedResponse({
      request,
      requestFingerprint,
      stage: "request",
      reasons: requestReasons,
    });
  }

  const approvalReasons = collectApprovalDenyReasons({
    approval: request.approval,
    requestFingerprint,
  });
  if (approvalReasons.length > 0) {
    return deniedResponse({
      request,
      requestFingerprint,
      stage: "operator-approval",
      reasons: approvalReasons,
    });
  }

  const gate = evaluateAcpxMutatingWrapperRuntimeGate({
    wrapperId: request.wrapperId,
    gates: request.gate.gates,
    forbiddenSurfaces: request.gate.forbiddenSurfaces,
    allowWrappers: request.gate.allowWrappers,
    denyWrappers: request.gate.denyWrappers,
  });
  if (!gate.allowed) {
    return deniedResponse({
      request,
      requestFingerprint,
      stage: "runtime-gate",
      reasons: [`mutating wrapper runtime gate denied: ${gate.reason}`],
      gate,
    });
  }

  return {
    schemaVersion: 1,
    kind: "acpx.mutating-wrapper.push-test.execution.response",
    wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
    method: ACPX_PUSH_TEST_METHOD,
    dryRun: true,
    noExecutionPerformed: true,
    requestId: request.requestId,
    createdAt: request.createdAt,
    status: "admitted",
    stage: "admitted",
    requestFingerprint,
    reasons: [],
    safeSummary: createAcpxPushTestSafeSummary(request.params),
    gate,
  };
}

function collectRequestDenyReasons(request: AcpxPushTestApprovalContractRequest): string[] {
  const reasons: string[] = [];
  if (request.schemaVersion !== 1) {
    reasons.push("ACPX push-test execution request schema version is unsupported");
  }
  if (request.kind !== "acpx.mutating-wrapper.push-test.execution.request") {
    reasons.push("ACPX push-test execution request kind is unsupported");
  }
  if (request.wrapperId !== ACPX_PUSH_TEST_WRAPPER_ID) {
    reasons.push("ACPX push-test execution request wrapper is unsupported");
  }
  if (request.method !== ACPX_PUSH_TEST_METHOD) {
    reasons.push("ACPX push-test execution request method is unsupported");
  }
  if (!request.dryRun) {
    reasons.push("ACPX push-test execution contract must be evaluated as a dry run");
  }
  if (typeof request.requestId !== "string" || request.requestId.trim() === "") {
    reasons.push("ACPX push-test execution request requires requestId");
  }
  if (typeof request.createdAt !== "string" || request.createdAt.trim() === "") {
    reasons.push("ACPX push-test execution request requires createdAt");
  }
  if (!validatePushTestParams(request.params)) {
    reasons.push("ACPX push-test execution request params are invalid");
  }
  return reasons;
}

function collectApprovalDenyReasons(params: {
  approval: AcpxPushTestOperatorApproval;
  requestFingerprint: string;
}): string[] {
  const reasons: string[] = [];
  if (params.approval.confirmation !== "operator-confirmed") {
    reasons.push("ACPX push-test execution requires explicit operator confirmation");
  }
  if (params.approval.acceptedRequestFingerprint !== params.requestFingerprint) {
    reasons.push("ACPX push-test approval fingerprint does not match request");
  }
  if (
    params.approval.confirmation === "operator-confirmed" &&
    (typeof params.approval.approvedAt !== "string" || params.approval.approvedAt.trim() === "")
  ) {
    reasons.push("ACPX push-test approval requires approvedAt");
  }
  return reasons;
}

function deniedResponse(params: {
  request: AcpxPushTestApprovalContractRequest;
  requestFingerprint: string;
  stage: AcpxPushTestApprovalContractResponseStage;
  reasons: string[];
  gate?: AcpxMutatingWrapperRuntimeGateDecision;
}): AcpxPushTestApprovalContractResponse {
  return {
    schemaVersion: 1,
    kind: "acpx.mutating-wrapper.push-test.execution.response",
    wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
    method: ACPX_PUSH_TEST_METHOD,
    dryRun: true,
    noExecutionPerformed: true,
    requestId: typeof params.request.requestId === "string" ? params.request.requestId : "",
    createdAt: typeof params.request.createdAt === "string" ? params.request.createdAt : "",
    status: "denied",
    stage: params.stage,
    requestFingerprint: params.requestFingerprint,
    reasons: params.reasons,
    safeSummary: createAcpxPushTestSafeSummary(params.request.params),
    ...(params.gate ? { gate: params.gate } : {}),
  };
}
