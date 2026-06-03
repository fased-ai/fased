import { describe, expect, it } from "vitest";
import {
  evaluateAcpxMutatingWrapperRuntimeGate,
  findAcpxMutatingWrapperDesign,
  isAcpxMutatingWrapperExecutionEnabled,
  listAcpxMutatingWrapperDesigns,
  validateAcpxMutatingWrapperDesigns,
  type AcpxMutatingWrapperGate,
} from "./acpx-mutating-wrapper-policy.js";

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

describe("ACPX mutating wrapper policy", () => {
  it("defines one disabled fixed wrapper design per mutating admin RPC", () => {
    const designs = listAcpxMutatingWrapperDesigns();

    expect(validateAcpxMutatingWrapperDesigns()).toEqual([]);
    expect(designs.map((design) => design.method).toSorted()).toEqual([
      "chat.inject",
      "push.test",
      "web.login.start",
      "web.login.wait",
    ]);
    expect(designs.every((design) => design.status === "design-only")).toBe(true);
    expect(designs.every((design) => !design.executionEnabled)).toBe(true);
  });

  it("requires the full safety gate set before any future wrapper can execute", () => {
    for (const design of listAcpxMutatingWrapperDesigns()) {
      expect(design.requiredGates).toEqual(
        expect.arrayContaining([
          "operator-scope",
          "operator-confirmation",
          "plugin-admin-rpc-grant",
          "plugin-source-allowlist",
          "audit",
          "rate-limit",
          "gateway-token",
          "explicit-wrapper-enable",
        ]),
      );
    }
  });

  it("keeps generic dispatchers, client MCP servers, and CLI MCP outside the design", () => {
    for (const design of listAcpxMutatingWrapperDesigns()) {
      expect(design.id).not.toContain("gateway_call");
      expect(design.id).not.toContain("dispatch");
      expect(design.forbiddenSurfaces).toEqual(
        expect.arrayContaining([
          "generic-gateway-dispatcher",
          "client-supplied-mcpServers",
          "cli-mcp",
          "untrusted-plugin-source",
          "bulk-enable-all-admin-rpcs",
        ]),
      );
    }
    expect(findAcpxMutatingWrapperDesign("fased_gateway_call")).toBeUndefined();
    expect(isAcpxMutatingWrapperExecutionEnabled("fased_chat_inject_request")).toBe(false);
  });

  it("denies unknown wrappers without creating a generic dispatcher escape hatch", () => {
    expect(
      evaluateAcpxMutatingWrapperRuntimeGate({
        wrapperId: "fased_gateway_call",
        gates: allRequiredGateState(),
      }),
    ).toEqual({
      wrapperId: "fased_gateway_call",
      allowed: false,
      reason: "unknown-wrapper",
      missingGates: [],
      activeForbiddenSurfaces: [],
    });
  });

  it("denies fixed wrappers by default until every runtime gate is present", () => {
    const decision = evaluateAcpxMutatingWrapperRuntimeGate({
      wrapperId: "fased_chat_inject_request",
    });

    expect(decision).toMatchObject({
      wrapperId: "fased_chat_inject_request",
      method: "chat.inject",
      allowed: false,
      reason: "missing-gates",
    });
    expect(decision.missingGates).toEqual(ALL_REQUIRED_GATES);
  });

  it("requires every explicit gate before a fixed wrapper can be admitted", () => {
    for (const missingGate of ALL_REQUIRED_GATES) {
      const gates = allRequiredGateState();
      gates[missingGate] = false;

      expect(
        evaluateAcpxMutatingWrapperRuntimeGate({
          wrapperId: "fased_push_test_request",
          gates,
        }),
      ).toMatchObject({
        allowed: false,
        reason: "missing-gates",
        missingGates: [missingGate],
      });
    }
  });

  it("admits a fixed wrapper only when the full gate set is satisfied", () => {
    expect(
      evaluateAcpxMutatingWrapperRuntimeGate({
        wrapperId: "fased_web_login_start_request",
        gates: allRequiredGateState(),
        allowWrappers: ["fased_web_login_start_request"],
      }),
    ).toEqual({
      wrapperId: "fased_web_login_start_request",
      method: "web.login.start",
      allowed: true,
      reason: "allowed",
      missingGates: [],
      activeForbiddenSurfaces: [],
    });
  });

  it("makes denyWrappers win over allowWrappers and ignores unknown allowlist entries", () => {
    expect(
      evaluateAcpxMutatingWrapperRuntimeGate({
        wrapperId: "fased_web_login_wait_request",
        gates: allRequiredGateState(),
        allowWrappers: ["fased_web_login_wait_request"],
        denyWrappers: ["fased_web_login_wait_request"],
      }),
    ).toMatchObject({
      allowed: false,
      reason: "denied-wrapper",
    });

    expect(
      evaluateAcpxMutatingWrapperRuntimeGate({
        wrapperId: "fased_web_login_wait_request",
        gates: allRequiredGateState(),
        allowWrappers: ["fased_unknown_wrapper"],
      }),
    ).toMatchObject({
      allowed: false,
      reason: "not-allowlisted",
    });
  });

  it("fails closed for caller MCP config, CLI MCP, generic dispatch, and bulk admin enablement", () => {
    const forbiddenSurfaces = [
      "generic-gateway-dispatcher",
      "client-supplied-mcpServers",
      "cli-mcp",
      "untrusted-plugin-source",
      "bulk-enable-all-admin-rpcs",
    ] as const;

    for (const surface of forbiddenSurfaces) {
      expect(
        evaluateAcpxMutatingWrapperRuntimeGate({
          wrapperId: "fased_chat_inject_request",
          gates: allRequiredGateState(),
          forbiddenSurfaces: {
            [surface]: true,
          },
        }),
      ).toMatchObject({
        allowed: false,
        reason: "forbidden-surface",
        activeForbiddenSurfaces: [surface],
      });
    }
  });
});
