import { randomUUID } from "node:crypto";
import type { AcpxMutatingWrapperGate } from "../../acp/acpx-mutating-wrapper-policy.js";
import {
  ACPX_PUSH_TEST_METHOD,
  ACPX_PUSH_TEST_WRAPPER_ID,
  evaluateAcpxPushTestApprovalContract,
  type AcpxPushTestApprovalContractRequest,
} from "../../acp/acpx-push-test-approval-contract.js";
import {
  executeAcpxPushTestRequest,
  type AcpxPushTestExecutionGate,
} from "../../acp/acpx-push-test-execution-adapter.js";
import { resolveAcpxMcpBridgeStatus } from "../../commands/status.acpx-bridge.js";
import { loadConfig } from "../../config/config.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import type { PushTestParams } from "../protocol/index.js";
import { getMutatingAdminRpcAuditHistorySnapshot } from "./mutating-admin-rpc-audit.js";
import { pushHandlers } from "./push.js";
import type { GatewayClient, GatewayRequestHandlers } from "./types.js";

const ACPX_PUSH_TEST_CONFIRM = "EXECUTE_ACPX_PUSH_TEST";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function buildPushTestParams(params: Record<string, unknown>): PushTestParams {
  return {
    nodeId: typeof params.nodeId === "string" ? params.nodeId.trim() : "",
    ...(typeof params.title === "string" ? { title: params.title } : {}),
    ...(typeof params.body === "string" ? { body: params.body } : {}),
    ...(params.environment === "sandbox" || params.environment === "production"
      ? { environment: params.environment }
      : {}),
  };
}

function hasOperatorWriteScope(client: GatewayClient | null): boolean {
  if (!client?.connect || (client.connect.role ?? "operator") !== "operator") {
    return false;
  }
  return authorizeOperatorScopesForMethod(ACPX_PUSH_TEST_METHOD, client.connect.scopes ?? [])
    .allowed;
}

function resolveGateState(params: {
  bridgeEnabled: boolean;
  operatorConfirmed: boolean;
  client: GatewayClient | null;
}): Record<AcpxMutatingWrapperGate, boolean> {
  return {
    "operator-scope": hasOperatorWriteScope(params.client),
    "operator-confirmation": params.operatorConfirmed,
    "plugin-admin-rpc-grant": params.bridgeEnabled,
    "plugin-source-allowlist": params.bridgeEnabled,
    audit: true,
    "rate-limit": true,
    "gateway-token": Boolean(params.client?.connect),
    "explicit-wrapper-enable": params.bridgeEnabled,
  };
}

function buildRequest(params: {
  rawParams: Record<string, unknown>;
  client: GatewayClient | null;
  operatorConfirmed: boolean;
  acceptedRequestFingerprint?: string;
}): AcpxPushTestApprovalContractRequest {
  const cfg = loadConfig();
  const bridge = resolveAcpxMcpBridgeStatus(cfg);
  const requestId = optionalString(params.rawParams.requestId) ?? `acpx-push-test:${randomUUID()}`;
  const approvedAt = params.operatorConfirmed ? new Date().toISOString() : undefined;
  return {
    schemaVersion: 1,
    kind: "acpx.mutating-wrapper.push-test.execution.request",
    wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
    method: ACPX_PUSH_TEST_METHOD,
    dryRun: true,
    requestId,
    createdAt: new Date().toISOString(),
    params: buildPushTestParams(params.rawParams),
    approval:
      params.operatorConfirmed && params.acceptedRequestFingerprint
        ? {
            confirmation: "operator-confirmed",
            acceptedRequestFingerprint: params.acceptedRequestFingerprint,
            operatorId: params.client?.connect?.client?.id ?? "operator",
            approvedAt: approvedAt ?? new Date().toISOString(),
          }
        : {
            confirmation: "none",
          },
    gate: {
      gates: resolveGateState({
        bridgeEnabled: bridge.fasedPushTestRequest.enabled,
        operatorConfirmed: params.operatorConfirmed,
        client: params.client,
      }),
      forbiddenSurfaces: {
        "generic-gateway-dispatcher": false,
        "client-supplied-mcpServers": false,
        "cli-mcp": false,
        "untrusted-plugin-source": false,
        "bulk-enable-all-admin-rpcs": false,
      },
      allowWrappers: bridge.allowTools,
      denyWrappers: bridge.denyTools,
    },
  };
}

function resolveExecutionGate(): AcpxPushTestExecutionGate {
  const cfg = loadConfig();
  const bridge = resolveAcpxMcpBridgeStatus(cfg);
  return {
    enabled: bridge.enabled,
    allowExecution: bridge.fasedPushTestRequest.enabled,
    gatewayHandlerRegistered: Boolean(pushHandlers[ACPX_PUSH_TEST_METHOD]),
  };
}

export const acpxPushTestHandlers: GatewayRequestHandlers = {
  "acpx.pushTest.auditHistory": ({ params, respond }) => {
    const limit = typeof params.limit === "number" ? params.limit : 12;
    const snapshot = getMutatingAdminRpcAuditHistorySnapshot({
      method: ACPX_PUSH_TEST_METHOD,
      limit,
    });
    respond(
      true,
      {
        schemaVersion: 1,
        kind: "acpx.mutating-wrapper.push-test.audit-history",
        wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
        method: ACPX_PUSH_TEST_METHOD,
        ...snapshot,
      },
      undefined,
    );
  },
  "acpx.pushTest.preview": ({ params, respond, client }) => {
    const request = buildRequest({
      rawParams: params,
      client,
      operatorConfirmed: false,
    });
    const response = evaluateAcpxPushTestApprovalContract(request);
    respond(
      true,
      {
        schemaVersion: 1,
        kind: "acpx.mutating-wrapper.push-test.preview",
        wrapperId: ACPX_PUSH_TEST_WRAPPER_ID,
        method: ACPX_PUSH_TEST_METHOD,
        requestId: request.requestId,
        response,
      },
      undefined,
    );
  },
  "acpx.pushTest.execute": async ({ params, respond, client, context, isWebchatConnect }) => {
    const acceptedRequestFingerprint = optionalString(params.acceptedRequestFingerprint);
    const operatorConfirmed =
      params.confirm === ACPX_PUSH_TEST_CONFIRM && Boolean(acceptedRequestFingerprint);
    const request = buildRequest({
      rawParams: params,
      client,
      operatorConfirmed,
      acceptedRequestFingerprint,
    });
    const result = await executeAcpxPushTestRequest({
      request,
      executionGate: resolveExecutionGate(),
      handler: pushHandlers[ACPX_PUSH_TEST_METHOD],
      context,
      client,
      isWebchatConnect,
    });
    respond(true, result, undefined);
  },
};
