import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  authorizeOperatorScopesForMethod,
  isGatewayMethodClassified,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./method-scopes.js";
import { listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";

describe("method scope resolution", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("classifies sessions.resolve as read and poll as write", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.resolve")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.subscribe")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.messages.subscribe")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.compaction.list")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.compaction.get")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.usage")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.usage.timeseries")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.usage.logs")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.compaction.branch")).toEqual([
      "operator.write",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.compaction.restore")).toEqual([
      "operator.admin",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("update.status")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("gateway.identity.get")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("diagnostics.stability")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("models.authStatus")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("doctor.memory.inventory")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("doctor.memory.repair.preview")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("doctor.memory.validate")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("doctor.memory.repair.execute")).toEqual([
      "operator.admin",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("doctor.memory.wiki.status")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("doctor.memory.wiki.rebuild")).toEqual([
      "operator.admin",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("tools.effective")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("acpx.pushTest.auditHistory")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("acpx.pushTest.preview")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("poll")).toEqual(["operator.write"]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("channels.start")).toEqual([
      "operator.write",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("channels.stop")).toEqual([
      "operator.write",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("node.pending.enqueue")).toEqual([
      "operator.write",
    ]);
    expect(listGatewayMethods()).toContain("models.authStatus");
    expect(resolveLeastPrivilegeOperatorScopesForMethod("node.pending.drain")).toEqual([]);
    expect(isGatewayMethodClassified("node.pending.drain")).toBe(true);
    expect(isGatewayMethodClassified("node.pending.pull")).toBe(true);
    expect(isGatewayMethodClassified("node.pending.ack")).toBe(true);
  });

  it("advertises safe read-only session lookup and usage methods", () => {
    expect(listGatewayMethods()).toEqual(
      expect.arrayContaining([
        "sessions.resolve",
        "sessions.usage",
        "sessions.usage.timeseries",
        "sessions.usage.logs",
      ]),
    );
  });

  it("returns empty scopes for unknown methods", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("totally.unknown.method")).toEqual([]);
  });

  it("keeps nativeHook.invoke closed until Fased owns a host-hook execution design", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("nativeHook.invoke")).toEqual([]);
    expect(isGatewayMethodClassified("nativeHook.invoke")).toBe(false);
    expect(coreGatewayHandlers["nativeHook.invoke"]).toBeUndefined();
  });

  it("keeps secrets.resolve closed to avoid gateway secret disclosure", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("secrets.resolve")).toEqual([]);
    expect(isGatewayMethodClassified("secrets.resolve")).toBe(false);
    expect(coreGatewayHandlers["secrets.resolve"]).toBeUndefined();
  });

  it("keeps extended doctor.memory preflight and dreaming RPCs closed", () => {
    const closedDoctorMemoryMethods = [
      "doctor.memory.dreamDiary",
      "doctor.memory.backfillDreamDiary",
      "doctor.memory.resetDreamDiary",
      "doctor.memory.resetGroundedShortTerm",
      "doctor.memory.repairDreamingArtifacts",
      "doctor.memory.repair.preflight",
      "doctor.memory.repair.preflight.pipeline",
      "doctor.memory.repair.preflight.cli-preview",
      "doctor.memory.repair.preflight.dashboard-preview",
      "doctor.memory.dedupeDreamDiary",
    ];
    const listedMethods = listGatewayMethods();

    for (const method of closedDoctorMemoryMethods) {
      expect(resolveLeastPrivilegeOperatorScopesForMethod(method)).toEqual([]);
      expect(isGatewayMethodClassified(method)).toBe(false);
      expect(listedMethods).not.toContain(method);
      expect(coreGatewayHandlers[method]).toBeUndefined();
    }
    expect(listedMethods.filter((method) => method.startsWith("doctor.memory."))).toEqual([
      "doctor.memory.inventory",
      "doctor.memory.repair.execute",
      "doctor.memory.repair.preview",
      "doctor.memory.status",
      "doctor.memory.validate",
      "doctor.memory.wiki.rebuild",
      "doctor.memory.wiki.status",
    ]);
    expect(coreGatewayHandlers["doctor.memory.repair.execute"]).toBeTypeOf("function");
  });

  it("keeps realtime talk and mutating TTS persona RPCs closed", () => {
    const closedTalkMethods = [
      "talk.realtime.session",
      "talk.realtime.relayAudio",
      "talk.realtime.relayMark",
      "talk.realtime.relayStop",
      "talk.realtime.relayToolResult",
      "talk.speak",
      "tts.setPersona",
    ];

    for (const method of closedTalkMethods) {
      expect(resolveLeastPrivilegeOperatorScopesForMethod(method)).toEqual([]);
      expect(isGatewayMethodClassified(method)).toBe(false);
      expect(coreGatewayHandlers[method]).toBeUndefined();
    }
  });

  it("keeps mutating admin helper RPCs scoped but unadvertised", () => {
    const listedMethods = listGatewayMethods();
    const methods = [
      { method: "chat.inject", scope: "operator.admin" },
      { method: "web.login.start", scope: "operator.admin" },
      { method: "web.login.wait", scope: "operator.admin" },
      { method: "push.test", scope: "operator.write" },
    ];

    for (const { method, scope } of methods) {
      expect(resolveLeastPrivilegeOperatorScopesForMethod(method)).toEqual([scope]);
      expect(isGatewayMethodClassified(method)).toBe(true);
      expect(coreGatewayHandlers[method]).toBeDefined();
      expect(listedMethods).not.toContain(method);
    }
  });

  it("keeps fixed ACPX push-test helper RPCs scoped but unadvertised", () => {
    const listedMethods = listGatewayMethods();
    const methods = [
      { method: "acpx.pushTest.auditHistory", scope: "operator.read" },
      { method: "acpx.pushTest.preview", scope: "operator.read" },
      { method: "acpx.pushTest.execute", scope: "operator.write" },
    ];

    for (const { method, scope } of methods) {
      expect(resolveLeastPrivilegeOperatorScopesForMethod(method)).toEqual([scope]);
      expect(isGatewayMethodClassified(method)).toBe(true);
      expect(coreGatewayHandlers[method]).toBeDefined();
      expect(listedMethods).not.toContain(method);
    }
  });

  it("does not let plugin registry scopes downgrade mutating admin helper RPCs", () => {
    const registry = createEmptyPluginRegistry();
    registry.gatewayMethodScopes["chat.inject"] = "operator.read";
    registry.gatewayMethodScopes["web.login.start"] = "operator.read";
    registry.gatewayMethodScopes["web.login.wait"] = "operator.read";
    registry.gatewayMethodScopes["push.test"] = "operator.read";
    setActivePluginRegistry(registry, "test-plugin-registry");

    expect(resolveLeastPrivilegeOperatorScopesForMethod("chat.inject")).toEqual(["operator.admin"]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("web.login.start")).toEqual([
      "operator.admin",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("web.login.wait")).toEqual([
      "operator.admin",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("push.test")).toEqual(["operator.write"]);
  });

  it("classifies plugin gateway methods from the active plugin registry", () => {
    const registry = createEmptyPluginRegistry();
    registry.gatewayMethodScopes["demo.ping"] = "operator.read";
    setActivePluginRegistry(registry, "test-plugin-registry");

    expect(resolveLeastPrivilegeOperatorScopesForMethod("demo.ping")).toEqual(["operator.read"]);
    expect(isGatewayMethodClassified("demo.ping")).toBe(true);
    expect(authorizeOperatorScopesForMethod("demo.ping", ["operator.read"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("demo.ping", [])).toEqual({
      allowed: false,
      missingScope: "operator.read",
    });
  });
});

describe("operator scope authorization", () => {
  it("allows read methods with operator.read or operator.write", () => {
    expect(authorizeOperatorScopesForMethod("health", ["operator.read"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("health", ["operator.write"])).toEqual({
      allowed: true,
    });
  });

  it("requires operator.write for write methods", () => {
    expect(authorizeOperatorScopesForMethod("send", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.write",
    });
  });

  it("requires approvals scope for approval methods", () => {
    expect(authorizeOperatorScopesForMethod("exec.approval.get", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.approvals",
    });
    expect(authorizeOperatorScopesForMethod("exec.approval.list", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.approvals",
    });
    expect(authorizeOperatorScopesForMethod("exec.approval.resolve", ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.approvals",
    });
    expect(resolveLeastPrivilegeOperatorScopesForMethod("exec.approval.get")).toEqual([
      "operator.approvals",
    ]);
  });

  it("requires admin for unknown methods", () => {
    expect(authorizeOperatorScopesForMethod("unknown.method", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
  });
});

describe("core gateway method classification", () => {
  it("classifies every exposed core gateway handler method", () => {
    const unclassified = Object.keys(coreGatewayHandlers).filter(
      (method) => !isGatewayMethodClassified(method),
    );
    expect(unclassified).toEqual([]);
  });
});
