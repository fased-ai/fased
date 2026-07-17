import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeJsonShape,
  expectNoUnsafeMemoryDoctorFields,
} from "../../../../src/memory/memory-doctor-readonly-test-helpers.js";
import {
  callDebugAdminRpcControl,
  callDebugAcpxPushTest,
  callDebugSatProtocolMaintenance,
  loadDebug,
  updateDebugAcpxBridgeConfig,
  type DebugState,
} from "./debug.ts";

function createStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function createDebugState(request: ReturnType<typeof vi.fn>): DebugState {
  return {
    client: { request } as unknown as DebugState["client"],
    connected: true,
    debugLoading: false,
    debugStatus: null,
    debugHealth: null,
    debugModels: [],
    debugModelCatalogStatus: null,
    debugCommandsCatalog: null,
    debugUpdateStatus: null,
    debugPluginsMarketplace: null,
    debugDiagnosticsStability: null,
    debugMemoryInventory: null,
    debugMemoryValidation: null,
    debugMemoryRepairPreview: null,
    debugHeartbeat: null,
    debugCallMethod: "",
    debugCallParams: "{}",
    debugCallResult: null,
    debugCallError: null,
    debugAdminRpcBusy: null,
    debugAdminRpcResult: null,
    debugAdminRpcError: null,
    debugAdminChatSessionKey: "",
    debugAdminChatMessage: "",
    debugAdminPushNodeId: "",
    debugAdminPushTitle: "Fased test push",
    debugAdminPushBody: "Operator test push",
    debugAdminWebAccountId: "main",
    debugAcpxBridgeConfigBusy: null,
    debugAcpxBridgeConfigResult: null,
    debugAcpxBridgeConfigError: null,
    debugAcpxPushTestBusy: null,
    debugAcpxPushTestPreview: null,
    debugAcpxPushTestAuditHistory: null,
    debugAcpxPushTestResult: null,
    debugAcpxPushTestError: null,
    debugSatProtocolMaintenanceBusy: false,
    debugSatProtocolMaintenanceResult: null,
    debugSatProtocolMaintenanceError: null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadDebug", () => {
  it("loads memory doctor inventory, validation, and dry-run repair preview", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "status":
          return {};
        case "health":
          return {};
        case "models.list":
          return { models: [] };
        case "models.catalog.status":
          return { totalProviders: 0, totalModels: 0, sourceCounts: {}, providers: [] };
        case "commands.list":
          return { commands: [] };
        case "update.status":
          return { summary: "current" };
        case "plugins.marketplace.list":
          return { plugins: [], diagnostics: [] };
        case "diagnostics.stability":
          return { count: 0, dropped: 0, summary: { byType: {} }, events: [] };
        case "doctor.memory.inventory":
          return {
            agentId: "main",
            workspace: { path: "/tmp/workspace", exists: true, memoryRoots: [] },
            backend: { configured: "builtin", citations: "auto" },
            qmd: { enabled: false },
            sessionMemory: {
              hookConfigured: false,
              enabled: false,
              memoryDir: { path: "/tmp/workspace/memory", exists: false, kind: "missing" },
            },
            memoryPlugin: { configuredSlot: null, enabled: false, registryLoaded: true },
          };
        case "doctor.memory.validate":
          return {
            agentId: "main",
            ok: false,
            summary: { errors: 1, warnings: 2, info: 0 },
            findings: [],
          };
        case "doctor.memory.repair.preview":
          return {
            agentId: "main",
            dryRun: true,
            ok: false,
            validation: { errors: 1, warnings: 2, info: 0 },
            summary: { proposals: 3, supported: 1, blocked: 2 },
            proposals: [],
          };
        case "acpx.pushTest.auditHistory":
          return {
            schemaVersion: 1,
            kind: "acpx.mutating-wrapper.push-test.audit-history",
            wrapperId: "fased_push_test_request",
            method: "push.test",
            generatedAt: "2026-04-30T00:00:00.000Z",
            capacity: 200,
            count: 0,
            dropped: 0,
            events: [],
          };
        case "last-heartbeat":
          return {};
        default:
          throw new Error(`unexpected method: ${method}`);
      }
    });
    const state = createDebugState(request);

    await loadDebug(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.inventory", {});
    expect(request).toHaveBeenCalledWith("doctor.memory.validate", {});
    expect(request).toHaveBeenCalledWith("doctor.memory.repair.preview", {});
    expect(request).toHaveBeenCalledWith("acpx.pushTest.auditHistory", { limit: 12 });
    expect(request).not.toHaveBeenCalledWith("doctor.memory.repair.execute", expect.anything());
    expect(request).not.toHaveBeenCalledWith("doctor.memory.repair.preflight", expect.anything());
    expect(request).not.toHaveBeenCalledWith(
      "doctor.memory.repair.preflight.dashboard-preview",
      expect.anything(),
    );
    expect(state.debugMemoryInventory?.agentId).toBe("main");
    expect(state.debugMemoryValidation?.summary.errors).toBe(1);
    expect(state.debugMemoryRepairPreview?.summary.proposals).toBe(3);
    expect(state.debugLoading).toBe(false);
  });

  it("keeps dashboard memory doctor data on the read-only json contract", async () => {
    const secretBody = "SECRET_TRANSCRIPT_BODY dashboard must not keep message body";
    const unsafeFields = {
      body: secretBody,
      transcript: secretBody,
      execute: "doctor.memory.repair.execute",
      gatewayHandler: "doctor.memory.repair.execute",
      request: { method: "doctor.memory.repair.execute", params: { body: secretBody } },
      writePath: "/tmp/unsafe-write",
    };
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "status":
          return {};
        case "health":
          return {};
        case "models.list":
          return { models: [] };
        case "models.catalog.status":
          return { totalProviders: 0, totalModels: 0, sourceCounts: {}, providers: [] };
        case "commands.list":
          return { commands: [] };
        case "update.status":
          return { summary: "current" };
        case "plugins.marketplace.list":
          return { plugins: [], diagnostics: [] };
        case "diagnostics.stability":
          return { count: 0, dropped: 0, summary: { byType: {} }, events: [] };
        case "doctor.memory.inventory":
          return {
            agentId: "main",
            ...unsafeFields,
            workspace: {
              path: "/tmp/workspace",
              exists: true,
              memoryRoots: [
                {
                  id: "memory-dir",
                  path: "/tmp/workspace/memory",
                  exists: true,
                  kind: "directory",
                  markdownFiles: 1,
                  ...unsafeFields,
                },
              ],
              ...unsafeFields,
            },
            backend: {
              configured: "builtin",
              citations: "auto",
              files: 1,
              chunks: 2,
              dirty: false,
              ...unsafeFields,
            },
            qmd: { enabled: false, ...unsafeFields },
            sessionMemory: {
              hookConfigured: false,
              enabled: false,
              memoryDir: {
                path: "/tmp/workspace/memory",
                exists: true,
                kind: "directory",
                markdownFiles: 1,
                ...unsafeFields,
              },
              ...unsafeFields,
            },
            memoryPlugin: {
              configuredSlot: null,
              enabled: false,
              registryLoaded: true,
              reason: "not enabled",
              ...unsafeFields,
            },
          };
        case "doctor.memory.validate":
          return {
            agentId: "main",
            ok: false,
            summary: { errors: 1, warnings: 0, info: 0 },
            findings: [
              {
                severity: "error",
                area: "workspace",
                code: "workspace.memory.empty",
                message: "No markdown memory files were found.",
                path: "/tmp/workspace",
                ...unsafeFields,
              },
            ],
            ...unsafeFields,
          };
        case "doctor.memory.repair.preview":
          return {
            agentId: "main",
            dryRun: true,
            ok: false,
            validation: { errors: 1, warnings: 0, info: 0 },
            summary: { proposals: 1, supported: 1, blocked: 0 },
            proposals: [
              {
                id: "proposal-1",
                area: "workspace",
                sourceCode: "workspace.memory.empty",
                severity: "error",
                action: "seed_memory",
                description: "Seed memory manually.",
                targetPath: "/tmp/workspace/MEMORY.md",
                dryRun: true,
                wouldMutate: true,
                requiresOperatorWrite: true,
                supported: false,
                blockReason: "manual only",
                ...unsafeFields,
              },
            ],
            ...unsafeFields,
          };
        case "acpx.pushTest.auditHistory":
          return {
            schemaVersion: 1,
            kind: "acpx.mutating-wrapper.push-test.audit-history",
            wrapperId: "fased_push_test_request",
            method: "push.test",
            generatedAt: "2026-04-30T00:00:00.000Z",
            capacity: 200,
            count: 0,
            dropped: 0,
            events: [],
          };
        case "last-heartbeat":
          return {};
        default:
          throw new Error(`unexpected method: ${method}`);
      }
    });
    const state = createDebugState(request);

    await loadDebug(state);

    const dashboardMemory = {
      inventory: state.debugMemoryInventory,
      validation: state.debugMemoryValidation,
      repairPreview: state.debugMemoryRepairPreview,
    };
    const serialized = JSON.stringify(dashboardMemory);
    expectNoUnsafeMemoryDoctorFields(dashboardMemory);
    expect(serialized).not.toContain(secretBody);
    expect(serialized).not.toMatch(
      /doctor\.memory\.repair\.execute|execute repair|repair executor|gateway handler/i,
    );
    expect(describeJsonShape(dashboardMemory)).toMatchInlineSnapshot(`
      {
        "inventory": {
          "agentId": "string",
          "backend": {
            "chunks": "number",
            "citations": "string",
            "configured": "string",
            "dirty": "boolean",
            "files": "number",
          },
          "memoryPlugin": {
            "configuredSlot": "null",
            "enabled": "boolean",
            "reason": "string",
            "registryLoaded": "boolean",
          },
          "qmd": {
            "enabled": "boolean",
          },
          "sessionMemory": {
            "enabled": "boolean",
            "hookConfigured": "boolean",
            "memoryDir": {
              "exists": "boolean",
              "kind": "string",
              "markdownFiles": "number",
              "path": "string",
            },
          },
          "workspace": {
            "exists": "boolean",
            "memoryRoots": [
              {
                "exists": "boolean",
                "id": "string",
                "kind": "string",
                "markdownFiles": "number",
                "path": "string",
              },
            ],
            "path": "string",
          },
        },
        "repairPreview": {
          "agentId": "string",
          "dryRun": "boolean",
          "ok": "boolean",
          "proposals": [
            {
              "action": "string",
              "area": "string",
              "blockReason": "string",
              "description": "string",
              "dryRun": "boolean",
              "id": "string",
              "requiresOperatorWrite": "boolean",
              "severity": "string",
              "sourceCode": "string",
              "supported": "boolean",
              "targetPath": "string",
              "wouldMutate": "boolean",
            },
          ],
          "summary": {
            "blocked": "number",
            "proposals": "number",
            "supported": "number",
          },
          "validation": {
            "errors": "number",
            "info": "number",
            "warnings": "number",
          },
        },
        "validation": {
          "agentId": "string",
          "findings": [
            {
              "area": "string",
              "code": "string",
              "message": "string",
              "path": "string",
              "severity": "string",
            },
          ],
          "ok": "boolean",
          "summary": {
            "errors": "number",
            "info": "number",
            "warnings": "number",
          },
        },
      }
    `);
  });
});

describe("callDebugAdminRpcControl", () => {
  it("confirms and calls chat.inject with operator dashboard label", async () => {
    const request = vi.fn(async () => ({ ok: true, messageId: "msg-1" }));
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const state = createDebugState(request);
    state.debugAdminChatSessionKey = "agent:main:main";
    state.debugAdminChatMessage = "operator note";

    await callDebugAdminRpcControl(state, "chat.inject");

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Inject an operator-labeled assistant message"),
    );
    expect(request).toHaveBeenCalledWith("chat.inject", {
      sessionKey: "agent:main:main",
      message: "operator note",
      label: "operator-dashboard",
    });
    expect(state.debugAdminRpcError).toBeNull();
    expect(state.debugAdminRpcResult).toContain("sanitized mutating-admin-rpc audit event");
  });

  it("does not call side-effecting RPCs when confirmation is cancelled", async () => {
    const request = vi.fn();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    const state = createDebugState(request);
    state.debugAdminPushNodeId = "ios-node-1";

    await callDebugAdminRpcControl(state, "push.test");

    expect(request).not.toHaveBeenCalled();
    expect(state.debugAdminRpcBusy).toBeNull();
  });

  it("requires operator inputs before confirming", async () => {
    const request = vi.fn();
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const state = createDebugState(request);

    await callDebugAdminRpcControl(state, "push.test");

    expect(confirm).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(state.debugAdminRpcError).toContain("Node id is required");
  });
});

describe("callDebugSatProtocolMaintenance", () => {
  it("runs the SAT maintenance gateway method after confirmation", async () => {
    const storage = createStorageMock();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("crypto", {
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
    });
    const request = vi.fn().mockResolvedValueOnce({
      submitted: [{ action: "refillRegistryReserveFromTreasury", txHash: "tx" }],
    });
    const state = createDebugState(request);

    await callDebugSatProtocolMaintenance(state);

    expect(request).toHaveBeenCalledWith("sat.runProtocolMaintenanceOnce", {
      idempotencyKey: "sat-maintain-ui-11111111-1111-4111-8111-111111111111",
    });
    expect(storage.getItem("fased.sat.maintenance.pending-idempotency.v1")).toBeNull();
    expect(state.debugSatProtocolMaintenanceResult).toContain("refillRegistryReserveFromTreasury");
    expect(state.debugSatProtocolMaintenanceError).toBeNull();
    expect(state.debugSatProtocolMaintenanceBusy).toBe(false);
  });

  it("does not run SAT maintenance when confirmation is denied", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    const request = vi.fn();
    const state = createDebugState(request);

    await callDebugSatProtocolMaintenance(state);

    expect(request).not.toHaveBeenCalled();
    expect(state.debugSatProtocolMaintenanceResult).toBeNull();
  });

  it("reuses the persisted maintenance key after an ambiguous request", async () => {
    const storage = createStorageMock();
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("crypto", { randomUUID });
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway response lost"))
      .mockResolvedValueOnce({ submitted: [] })
      .mockResolvedValueOnce({ submitted: [] });
    const state = createDebugState(request);

    await callDebugSatProtocolMaintenance(state);
    await callDebugSatProtocolMaintenance(state);
    await callDebugSatProtocolMaintenance(state);

    const keys = request.mock.calls.map(
      (call) => (call[1] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });
});

describe("updateDebugAcpxBridgeConfig", () => {
  it("enables only the fixed push-test wrapper after confirmation", async () => {
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            plugins: {
              entries: {
                acpx: {
                  config: {
                    mcpBridge: {
                      enabled: true,
                      mode: "read-only-tools",
                      allowTools: ["fased_gateway_identity"],
                      denyTools: ["fased_push_test_request"],
                    },
                  },
                },
              },
            },
          },
        };
      }
      if (method === "config.patch") {
        return { ok: true, params };
      }
      if (
        [
          "status",
          "health",
          "models.list",
          "models.catalog.status",
          "commands.list",
          "update.status",
          "plugins.marketplace.list",
          "diagnostics.stability",
          "doctor.memory.inventory",
          "doctor.memory.validate",
          "doctor.memory.repair.preview",
          "acpx.pushTest.auditHistory",
          "last-heartbeat",
        ].includes(method)
      ) {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const state = createDebugState(request);

    await updateDebugAcpxBridgeConfig(state, "enable-push-test");

    expect(request).toHaveBeenCalledWith("config.patch", {
      baseHash: "hash-1",
      raw: JSON.stringify({
        plugins: {
          entries: {
            acpx: {
              enabled: true,
              config: {
                mcpBridge: {
                  enabled: true,
                  mode: "operator-approved-mutating-tools",
                  allowTools: ["fased_gateway_identity", "fased_push_test_request"],
                  denyTools: [],
                },
              },
            },
          },
        },
      }),
      note: "ACPX MCP bridge set to operator-approved mutating tools with fased_push_test_request allowlisted.",
    });
    expect(state.debugAcpxBridgeConfigResult).toContain("enable-push-test");
    expect(state.debugAcpxBridgeConfigError).toBeNull();
  });

  it("does not enable push-test when setting read-only bridge mode", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            plugins: {
              entries: {
                acpx: {
                  config: {
                    mcpBridge: {
                      enabled: true,
                      mode: "operator-approved-mutating-tools",
                      allowTools: ["fased_push_test_request", "fased_update_status"],
                      denyTools: [],
                    },
                  },
                },
              },
            },
          },
        };
      }
      if (method === "config.patch") {
        return { ok: true };
      }
      return {};
    });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const state = createDebugState(request);

    await updateDebugAcpxBridgeConfig(state, "read-only-tools");

    expect(request).toHaveBeenCalledWith(
      "config.patch",
      expect.objectContaining({
        raw: JSON.stringify({
          plugins: {
            entries: {
              acpx: {
                config: {
                  mcpBridge: {
                    enabled: true,
                    mode: "read-only-tools",
                    allowTools: ["fased_update_status"],
                    denyTools: ["fased_push_test_request"],
                  },
                },
              },
            },
          },
        }),
      }),
    );
  });

  it("does not patch config when confirmation is cancelled", async () => {
    const request = vi.fn();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    const state = createDebugState(request);

    await updateDebugAcpxBridgeConfig(state, "enable-push-test");

    expect(request).not.toHaveBeenCalled();
    expect(state.debugAcpxBridgeConfigBusy).toBeNull();
  });
});

describe("callDebugAcpxPushTest", () => {
  it("previews the fixed wrapper approval request without execution", async () => {
    const request = vi.fn(async (method: string, params: unknown) => {
      expect(method).toBe("acpx.pushTest.preview");
      expect(params).toEqual({
        nodeId: "ios-node-1",
        title: "Fased test push",
        body: "Operator test push",
      });
      return {
        schemaVersion: 1,
        kind: "acpx.mutating-wrapper.push-test.preview",
        wrapperId: "fased_push_test_request",
        method: "push.test",
        requestId: "req-1",
        response: {
          status: "denied",
          stage: "operator-approval",
          requestFingerprint: "fingerprint-1",
          reasons: ["ACPX push-test execution requires explicit operator confirmation"],
          safeSummary: {
            nodeId: "ios-node-1",
            environment: null,
            titleProvided: true,
            bodyProvided: true,
          },
        },
      };
    });
    const state = createDebugState(request);
    state.debugAdminPushNodeId = "ios-node-1";

    await callDebugAcpxPushTest(state, "preview");

    expect(state.debugAcpxPushTestPreview?.response.requestFingerprint).toBe("fingerprint-1");
    expect(state.debugAcpxPushTestResult).toBeNull();
    expect(state.debugAcpxPushTestError).toBeNull();
  });

  it("executes with the preview fingerprint only after operator confirmation", async () => {
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "acpx.pushTest.execute") {
        expect(params).toEqual({
          nodeId: "ios-node-1",
          title: "Fased test push",
          body: "Operator test push",
          confirm: "EXECUTE_ACPX_PUSH_TEST",
          acceptedRequestFingerprint: "fingerprint-1",
        });
        return {
          status: "executed",
          executionPerformed: true,
          noGenericDispatcher: true,
        };
      }
      if (
        [
          "status",
          "health",
          "models.list",
          "models.catalog.status",
          "commands.list",
          "update.status",
          "plugins.marketplace.list",
          "diagnostics.stability",
          "doctor.memory.inventory",
          "doctor.memory.validate",
          "doctor.memory.repair.preview",
          "acpx.pushTest.auditHistory",
          "last-heartbeat",
        ].includes(method)
      ) {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const state = createDebugState(request);
    state.debugAdminPushNodeId = "ios-node-1";
    state.debugAcpxPushTestPreview = {
      schemaVersion: 1,
      kind: "acpx.mutating-wrapper.push-test.preview",
      wrapperId: "fased_push_test_request",
      method: "push.test",
      requestId: "req-1",
      response: {
        status: "denied",
        stage: "operator-approval",
        requestFingerprint: "fingerprint-1",
        reasons: [],
        safeSummary: {
          nodeId: "ios-node-1",
          environment: null,
          titleProvided: true,
          bodyProvided: true,
        },
      },
    };

    await callDebugAcpxPushTest(state, "execute");

    expect(state.debugAcpxPushTestResult).toContain("executed");
    expect(state.debugAcpxPushTestError).toBeNull();
  });

  it("does not execute without a preview fingerprint", async () => {
    const request = vi.fn();
    const state = createDebugState(request);
    state.debugAdminPushNodeId = "ios-node-1";

    await callDebugAcpxPushTest(state, "execute");

    expect(request).not.toHaveBeenCalled();
    expect(state.debugAcpxPushTestError).toContain("Preview");
  });
});
