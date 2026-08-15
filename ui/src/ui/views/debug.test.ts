import { describe, expect, it, vi } from "vitest";
import { expectNoMemoryDoctorTranscriptLeak } from "../../../../src/memory/memory-doctor-readonly-test-helpers.js";
import type { DebugProps } from "./debug.ts";

type LitTemplateLike = {
  strings?: ArrayLike<string>;
  values?: unknown[];
};

function flattenTemplateText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => flattenTemplateText(entry)).join(" ");
  }
  if (value && typeof value === "object") {
    const template = value as LitTemplateLike;
    if (template.strings && Array.isArray(template.values)) {
      const parts: string[] = [];
      const strings = Array.from(template.strings);
      for (const [index, chunk] of strings.entries()) {
        parts.push(chunk);
        if (index < template.values.length) {
          parts.push(flattenTemplateText(template.values[index]));
        }
      }
      return parts.join(" ");
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  if (typeof value === "function" || value == null || typeof value === "boolean") {
    return "";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }
  return "";
}

function normalizeRenderedText(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBetween(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = value.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return value.slice(startIndex, endIndex);
}

function renderDebugForTest(
  renderDebug: (props: DebugProps) => unknown,
  props: Partial<DebugProps>,
) {
  return renderDebug({
    loading: false,
    status: {},
    health: {},
    models: [],
    heartbeat: {},
    eventLog: [],
    methods: ["status"],
    callMethod: "status",
    callParams: "{}",
    callResult: null,
    callError: null,
    adminRpcBusy: null,
    adminRpcResult: null,
    adminRpcError: null,
    adminChatSessionKey: "main",
    adminChatMessage: "",
    adminPushNodeId: "",
    adminPushTitle: "",
    adminPushBody: "",
    adminWebAccountId: "",
    onCallMethodChange: () => undefined,
    onCallParamsChange: () => undefined,
    onAdminChatSessionKeyChange: () => undefined,
    onAdminChatMessageChange: () => undefined,
    onAdminPushNodeIdChange: () => undefined,
    onAdminPushTitleChange: () => undefined,
    onAdminPushBodyChange: () => undefined,
    onAdminWebAccountIdChange: () => undefined,
    onRefresh: () => undefined,
    onCall: () => undefined,
    onAdminRpcAction: () => undefined,
    ...props,
  });
}

describe("renderDebug", () => {
  it("renders SAT protocol maintenance as an advanced operator action", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    vi.stubGlobal("navigator", { language: "en-US" });
    const { renderDebug } = await import("./debug.ts");
    const text = normalizeRenderedText(
      flattenTemplateText(
        renderDebugForTest(renderDebug, {
          onSatProtocolMaintenance: () => undefined,
        }),
      ),
    );

    expect(text).toContain("SAT Protocol Maintenance");
    expect(text).toContain("Run maintenance once");
    expect(text).toContain("does not start mining");
  });

  it("renders task audit categories and maintenance status in Debug", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    vi.stubGlobal("navigator", { language: "en-US" });
    const { renderDebug } = await import("./debug.ts");
    const text = normalizeRenderedText(
      flattenTemplateText(
        renderDebugForTest(renderDebug, {
          taskLedgerBusy: false,
          taskLedgerError: null,
          taskLedgerMaintenanceMessage: "Task maintenance updated 1 record; 4 warnings remain.",
          taskLedger: {
            generatedAt: 1,
            total: 4,
            tasks: [],
            summary: {
              total: 4,
              queued: 1,
              running: 1,
              terminal: 2,
              failed: 1,
              lost: 0,
              bySource: { cron: 1, media: 1, CLI: 2 },
              byStatus: { running: 1, succeeded: 1, failed: 1, queued: 1 },
            },
            audit: {
              findings: [
                {
                  code: "stale-running-task",
                  severity: "warn",
                  message: "Task task-stale has been running for 420 minutes.",
                  taskId: "task-stale",
                  runId: "run-stale",
                  source: "media",
                },
                {
                  code: "missing-delivery-state",
                  severity: "warn",
                  message: "Task task-delivery ended with pending delivery state.",
                  taskId: "task-delivery",
                  source: "media",
                },
                {
                  code: "orphaned-cron-task",
                  severity: "warn",
                  message: "Persistent cron task task-cron is not present in the cron run queue.",
                  taskId: "task-cron",
                  source: "cron",
                },
                {
                  code: "broken-workflow-graph-edge",
                  severity: "warn",
                  message: "Saved workflow definition bad-graph is invalid and will be ignored.",
                  source: "CLI",
                },
              ],
            },
          },
        }),
      ),
    );

    expect(text).toContain("Task Audit");
    expect(text).toContain("Run maintenance");
    expect(text).toContain("Task maintenance updated 1 record; 4 warnings remain.");
    expect(text).toContain("Stale running work");
    expect(text).toContain("Delivery state");
    expect(text).toContain("Cron reconciliation");
    expect(text).toContain("Workflow definitions");
    expect(text).toContain("broken-workflow-graph-edge");
    vi.unstubAllGlobals();
  });

  it("renders operator economy fee ops surfaces as read-only internal data", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    vi.stubGlobal("navigator", { language: "en-US" });
    const { renderDebug } = await import("./debug.ts");
    const text = flattenTemplateText(
      renderDebugForTest(renderDebug, {
        loading: false,
        status: {
          gatewayStartup: {
            entries: [{ name: "plugins.load", durationMs: 12 }],
            totalMs: 25,
            summary: "plugins.load=12ms, total=25ms",
            recordedAtMs: 1770000000000,
          },
          strictAgentic: {
            mode: "warn",
            source: "default-config",
            envFlagSet: false,
            enforcementAvailable: false,
            warningAgents: 1,
            totalAgents: 2,
            agents: [
              { agentId: "main", mode: "warn", source: "default-config", override: false },
              { agentId: "ops", mode: "off", source: "agent-config", override: true },
            ],
          },
        },
        health: {},
        models: [],
        modelCatalogStatus: {
          checkedAtMs: 1770000000000,
          cache: {
            modelCatalog: "shared-loader",
            providerExtensionCatalog: "fresh-status-load",
          },
          totalProviders: 2,
          totalModels: 4,
          configuredProviders: 1,
          availableProviders: 1,
          reasoningModels: 2,
          visionModels: 1,
          capabilityCounts: {
            textModels: 4,
            visionModels: 1,
            reasoningModels: 2,
            toolsModels: 0,
            jsonModels: 0,
            audioModels: 0,
          },
          sourceCounts: { runtime: 2, "provider-index": 2 },
          providers: [
            {
              provider: "openrouter",
              totalModels: 3,
              configured: true,
              reasoningModels: 2,
              visionModels: 1,
              sources: ["runtime", "provider-index"],
              sourceConfidence: "known",
              capabilityCounts: {
                textModels: 3,
                visionModels: 1,
                reasoningModels: 2,
                toolsModels: 0,
                jsonModels: 0,
                audioModels: 0,
              },
              authModes: ["api_key"],
              privateNetwork: { models: 0, allowed: 0, blocked: 0 },
              probeStatus: "ok",
            },
            {
              provider: "ollama",
              totalModels: 1,
              configured: false,
              reasoningModels: 0,
              visionModels: 0,
              sources: ["provider-index"],
              sourceConfidence: "known",
              capabilityCounts: {
                textModels: 1,
                visionModels: 0,
                reasoningModels: 0,
                toolsModels: 0,
                jsonModels: 0,
                audioModels: 0,
              },
              authModes: [],
              privateNetwork: { models: 1, allowed: 0, blocked: 1 },
              probeStatus: "unknown",
            },
          ],
          providerExtensionCatalog: {
            totalEntries: 2,
            loadedEntries: 1,
            skippedUntrustedEntries: 1,
            emptyEntries: 0,
            errorEntries: 1,
            modelCount: 2,
            loadedProviderIds: ["openrouter", "ollama"],
            warnings: [
              {
                id: "provider-catalog.bad",
                source: "extensions/bad/provider-catalog.ts",
                trusted: false,
                providerIds: ["bad"],
                loadedProviderIds: [],
                modelCount: 0,
                status: "skipped-untrusted",
              },
              {
                id: "provider-catalog.error",
                source: "extensions/error/provider-catalog.ts",
                trusted: true,
                providerIds: ["broken"],
                loadedProviderIds: [],
                modelCount: 0,
                status: "error",
                error: "load failed",
              },
            ],
            entries: [],
          },
          providerExtensionManifest: {
            upstreamProviderCount: 4,
            mappedProviderCount: 2,
            deferredProviderCount: 1,
            mappedProviderIds: ["openrouter", "ollama"],
            deferredProviderIds: ["moonshot"],
            missingMappedProviderIds: ["zai"],
          },
        },
        commandsCatalog: {
          commands: [
            {
              name: "status",
              description: "Show status",
              source: "native",
              scope: "both",
              acceptsArgs: false,
            },
          ],
        },
        diagnosticsStability: {
          generatedAt: "2026-04-30T00:00:00.000Z",
          capacity: 1000,
          count: 2,
          dropped: 0,
          firstSeq: 41,
          lastSeq: 42,
          summary: {
            byType: {
              "message.queued": 1,
              "session.stuck": 1,
            },
            sessions: {
              stuck: 1,
              maxQueueDepth: 2,
            },
          },
          events: [
            {
              seq: 41,
              ts: 1770000000000,
              type: "message.queued",
              channel: "telegram",
              source: "inbound",
              queueDepth: 2,
            },
            {
              seq: 42,
              ts: 1770000001000,
              type: "session.stuck",
              ageMs: 120000,
              queueDepth: 2,
            },
          ],
        },
        memoryInventory: {
          agentId: "main",
          workspace: {
            path: "/tmp/fased-memory-debug/workspace",
            exists: true,
            memoryRoots: [
              {
                id: "memory-dir",
                path: "/tmp/fased-memory-debug/workspace/memory",
                exists: true,
                kind: "directory",
                markdownFiles: 2,
              },
            ],
          },
          backend: { configured: "builtin", active: "builtin", citations: "auto" },
          qmd: { enabled: false },
          sessionMemory: {
            hookConfigured: true,
            enabled: true,
            memoryDir: {
              path: "/tmp/fased-memory-debug/workspace/memory",
              exists: true,
              kind: "directory",
              markdownFiles: 2,
            },
          },
          memoryPlugin: { configuredSlot: null, enabled: false, registryLoaded: true },
        },
        memoryValidation: {
          agentId: "main",
          ok: false,
          summary: { errors: 1, warnings: 1, info: 0 },
          findings: [
            {
              severity: "error",
              area: "session-memory",
              code: "session_memory.missing",
              message: "Session memory file is missing",
              path: "/tmp/fased-memory-debug/workspace/memory/session.md",
            },
          ],
        },
        memoryRepairPreview: {
          agentId: "main",
          dryRun: true,
          ok: false,
          validation: { errors: 1, warnings: 1, info: 0 },
          summary: { proposals: 2, supported: 1, blocked: 1 },
          proposals: [
            {
              id: "proposal-create-session",
              area: "session-memory",
              sourceCode: "session_memory.missing",
              severity: "error",
              action: "create_file",
              description: "Create the missing session memory file",
              targetPath: "/tmp/fased-memory-debug/workspace/memory/session.md",
              dryRun: true,
              wouldMutate: true,
              requiresOperatorWrite: true,
              supported: true,
            },
            {
              id: "proposal-review-config",
              area: "backend",
              sourceCode: "config.manual",
              severity: "warn",
              action: "review_config",
              description: "Review memory config manually",
              dryRun: true,
              wouldMutate: true,
              requiresOperatorWrite: true,
              supported: false,
              blockReason: "config mutation is not part of memory repair preview",
            },
          ],
        },
        heartbeat: {},
        eventLog: [],
        methods: ["status"],
        callMethod: "status",
        callParams: "{}",
        callResult: null,
        callError: null,
        feeOpsLoading: false,
        feeOpsError: null,
        feeCollectionStatus: [
          {
            lane: "marketplace",
            enabled: false,
            reason:
              "fee collection is disabled until the multi-day measurement history threshold is met",
            thresholds: {
              historyDays: 14,
              marketplaceRuns: 30,
              disputeNotaryCases: 10,
              settlementVerifierCases: 10,
              routingRuns: 30,
            },
            observed: {
              historyDaysObserved: 3,
              marketplaceRunsObserved: 3,
              disputeNotaryCasesObserved: 1,
              settlementVerifierCasesObserved: 1,
              routingRunsObserved: 0,
            },
          },
        ],
        feeObjects: [
          {
            feeId: "mock-fee-debug-1",
            schema: "https://fased.ai/schemas/operator-economy/fee-object-v0.json",
            lane: "marketplace",
            status: "collected",
            policyVersion: "oe-fees-v0",
            amount: "1.5",
            asset: {
              chain: "solana",
              symbol: "USDC",
              kind: "spl-token",
            },
            allocationPlan: [{ bucket: "federation_ops_reserve", amount: "1.5" }],
            reviewState: "approved",
            body: {},
            createdAt: "2026-04-20T00:00:00.000Z",
            updatedAt: "2026-04-20T00:05:00.000Z",
          },
        ],
        feeBucketJournal: [
          {
            journalId: "mock-fee-debug-1::allocation::0",
            feeId: "mock-fee-debug-1",
            bucket: "federation_ops_reserve",
            asset: {
              chain: "solana",
              symbol: "USDC",
              kind: "spl-token",
            },
            amount: "1.5",
            direction: "credit",
            entryType: "allocation",
            policyVersion: "oe-fees-v0",
            createdAt: "2026-04-20T00:05:00.000Z",
          },
        ],
        feeBucketBalances: [
          {
            bucket: "federation_ops_reserve",
            asset: {
              chain: "solana",
              symbol: "USDC",
              kind: "spl-token",
            },
            credited: "1.5",
            debited: "0",
            heldBalance: "1.5",
          },
        ],
        feeReconciliationReports: [
          {
            reportId: "mock-reconcile-debug-1",
            periodStart: "2026-04-19T00:00:00.000Z",
            periodEnd: "2026-04-20T00:00:00.000Z",
            bucket: "federation_ops_reserve",
            asset: {
              chain: "solana",
              symbol: "USDC",
              kind: "spl-token",
            },
            expectedBalance: "1.5",
            observedBalance: "1.5",
            variance: "0",
            reviewState: "clean",
            reviewedBy: ["fc"],
          },
        ],
        onCallMethodChange: () => undefined,
        onCallParamsChange: () => undefined,
        onRefresh: () => undefined,
        onCall: () => undefined,
      }),
    );

    expect(text).toContain("Debug Surface Map");
    expect(text).toContain("read-only status");
    expect(text).toContain("admin/write audited");
    expect(text).toContain("Not generic exposure");
    expect(text).toContain("Manual RPC");
    expect(text).toContain("Expert path");
    expect(text).toContain("Network Fee Ops");
    expect(text).toContain("Provider Catalog");
    expect(text).toContain("openrouter");
    expect(text).toContain("provider-index");
    expect(text).toContain("Provider extension catalog");
    expect(text).toContain("provider-index models");
    expect(text).toContain("skipped untrusted");
    expect(text).toContain("Provider extension manifest");
    expect(text).toContain("moonshot");
    expect(text).toContain("provider-catalog.error");
    expect(text).toContain("Command Catalog");
    expect(text).toContain("status");
    expect(text).not.toContain("Update Status");
    expect(text).toContain("Gateway Startup");
    expect(text).toContain("plugins.load");
    expect(text).toContain("Strict-Agentic Policy");
    expect(text).toContain("1/2 warn");
    expect(text).toContain("per-agent override");
    expect(text).toContain("enforcement disabled");
    expect(text).toContain("Diagnostic Stability");
    expect(text).toContain("message.queued");
    expect(text).toContain("max queue");
    expect(text).toContain("stuck sessions");
    expect(text).toContain("Memory Repair Preview");
    expect(text).toContain("gated writes");
    expect(text).toContain("explicit confirmation");
    expect(text).toContain("supported dry-run");
    expect(text).toContain("[path:session.md]");
    expect(text).toContain("Repair execution is write-capable and operator-only");
    expect(text).toContain("backup, audit, and");
    expect(text).toContain("rollback metadata");
    expect(text).toContain("Execute 1 supported repairs");
    expect(text).toContain("operator.admin");
    expect(text).not.toContain("/tmp/fased-memory-debug/workspace/memory/session.md");
    expect(text).toContain("collection is disabled");
    expect(text).toContain("history 3/14d");
    expect(text).toContain("mock-fee-debug-1");
    expect(text).toContain("mock-reconcile-debug-1");
    vi.unstubAllGlobals();
  });

  it("renders ACPX bridge config controls with push-test state", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    vi.stubGlobal("navigator", { language: "en-US" });
    const { renderDebug } = await import("./debug.ts");
    const text = flattenTemplateText(
      renderDebugForTest(renderDebug, {
        loading: false,
        status: {
          acpxMcpBridge: {
            pluginId: "acpx",
            enabled: true,
            mode: "operator-approved-mutating-tools",
            configuredMode: "operator-approved-mutating-tools",
            allowTools: ["fased_gateway_identity", "fased_push_test_request"],
            denyTools: [],
            fasedPushTestRequest: {
              toolName: "fased_push_test_request",
              enabled: true,
              allowed: true,
              denied: false,
              reason: "enabled",
            },
          },
        },
        health: {},
        models: [],
        heartbeat: {},
        eventLog: [],
        methods: ["status"],
        callMethod: "status",
        callParams: "{}",
        callResult: null,
        callError: null,
        onCallMethodChange: () => undefined,
        onCallParamsChange: () => undefined,
        onRefresh: () => undefined,
        onCall: () => undefined,
        onAcpxBridgeConfigAction: () => undefined,
      }),
    );

    expect(text).toContain("ACPX Bridge Config");
    expect(text).toContain("mode");
    expect(text).toContain("operator-approved-mutating-tools");
    expect(text).toContain("fased_push_test_request");
    expect(text).toContain("enabled");
    expect(text).toContain("Enable push-test wrapper");
    expect(text).toContain("Deny push-test wrapper");
    vi.unstubAllGlobals();
  });

  it("renders ACPX push-test approval and result state", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    vi.stubGlobal("navigator", { language: "en-US" });
    const { renderDebug } = await import("./debug.ts");
    const text = flattenTemplateText(
      renderDebugForTest(renderDebug, {
        loading: false,
        status: {
          acpxMcpBridge: {
            pluginId: "acpx",
            enabled: true,
            mode: "operator-approved-mutating-tools",
            configuredMode: "operator-approved-mutating-tools",
            allowTools: ["fased_push_test_request"],
            denyTools: [],
            fasedPushTestRequest: {
              toolName: "fased_push_test_request",
              enabled: true,
              allowed: true,
              denied: false,
              reason: "enabled",
            },
          },
        },
        health: {},
        models: [],
        heartbeat: {},
        eventLog: [],
        methods: ["status"],
        callMethod: "status",
        callParams: "{}",
        callResult: null,
        callError: null,
        adminRpcBusy: null,
        adminRpcResult: null,
        adminRpcError: null,
        adminChatSessionKey: "",
        adminChatMessage: "",
        adminPushNodeId: "ios-node-1",
        adminPushTitle: "Push title",
        adminPushBody: "Push body",
        adminWebAccountId: "main",
        acpxPushTestPreview: {
          schemaVersion: 1,
          kind: "acpx.mutating-wrapper.push-test.preview",
          wrapperId: "fased_push_test_request",
          method: "push.test",
          requestId: "req-1",
          response: {
            status: "denied",
            stage: "operator-approval",
            requestFingerprint: "1234567890abcdef1234567890abcdef", // pragma: allowlist secret
            reasons: ["ACPX push-test execution requires explicit operator confirmation"],
            safeSummary: {
              nodeId: "ios-node-1",
              environment: null,
              titleProvided: true,
              bodyProvided: true,
            },
          },
        },
        acpxPushTestResult: JSON.stringify({
          status: "executed",
          executionPerformed: true,
          noGenericDispatcher: true,
        }),
        acpxPushTestAuditHistory: {
          schemaVersion: 1,
          kind: "acpx.mutating-wrapper.push-test.audit-history",
          wrapperId: "fased_push_test_request",
          method: "push.test",
          generatedAt: "2026-04-30T00:00:00.000Z",
          capacity: 200,
          count: 2,
          dropped: 0,
          firstSeq: 10,
          lastSeq: 11,
          events: [
            {
              seq: 10,
              ts: 1770000000000,
              method: "push.test",
              outcome: "denied",
              actor: "dashboard",
              deviceId: "operator-laptop",
              clientIp: "127.0.0.1",
              connId: "conn-operator",
              details: {
                reason: "rate_limited",
                limit: "3 per 60s",
                retryAfterMs: "30000",
                title: "<redacted>",
                body: "<redacted>",
                token: "<redacted>",
              },
            },
            {
              seq: 11,
              ts: 1770000001000,
              method: "push.test",
              outcome: "succeeded",
              actor: "dashboard",
              deviceId: "operator-laptop",
              clientIp: "127.0.0.1",
              connId: "conn-operator",
              details: {
                nodeId: "ios-node-1",
                environment: "sandbox",
                status: "200",
              },
            },
          ],
        },
        onCallMethodChange: () => undefined,
        onCallParamsChange: () => undefined,
        onAdminChatSessionKeyChange: () => undefined,
        onAdminChatMessageChange: () => undefined,
        onAdminPushNodeIdChange: () => undefined,
        onAdminPushTitleChange: () => undefined,
        onAdminPushBodyChange: () => undefined,
        onAdminWebAccountIdChange: () => undefined,
        onRefresh: () => undefined,
        onCall: () => undefined,
        onAdminRpcAction: () => undefined,
        onAcpxPushTestAction: () => undefined,
      }),
    );

    expect(text).toContain("ACPX Push-Test Approval");
    expect(text).toContain("fased_push_test_request");
    expect(text).toContain("Request fingerprint");
    expect(text).toContain("operator-approval");
    expect(text).toContain("Approve and send fixed wrapper");
    expect(text).toContain("noGenericDispatcher");
    expect(text).toContain("Recent audit history");
    expect(text).toContain("rate-limit aware");
    expect(text).toContain("reason=rate_limited");
    expect(text).toContain("succeeded");
    expect(text).not.toContain("secret title");
    expect(text).not.toContain("secret body");
    expect(text).not.toContain("secret token");
    vi.unstubAllGlobals();
  });

  it("redacts memory repair preview target paths in dashboard output", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    vi.stubGlobal("navigator", { language: "en-US" });
    const { renderDebug } = await import("./debug.ts");
    const secretPath = "/private/fased/workspaces/customer-alpha/memory/transcript-secret.md";
    const secretTranscript = "SECRET_TRANSCRIPT_BODY should never render"; // pragma: allowlist secret
    const text = flattenTemplateText(
      renderDebugForTest(renderDebug, {
        loading: false,
        status: {},
        health: {},
        models: [],
        heartbeat: {},
        eventLog: [],
        methods: ["status"],
        callMethod: "status",
        callParams: "{}",
        callResult: null,
        callError: null,
        memoryInventory: {
          agentId: "main",
          workspace: {
            path: "/private/fased/workspaces/customer-alpha",
            exists: true,
            memoryRoots: [],
          },
          backend: { configured: "builtin", citations: "auto" },
          qmd: { enabled: false },
          sessionMemory: {
            hookConfigured: true,
            enabled: true,
            memoryDir: { path: secretPath, exists: false, kind: "missing" },
          },
          memoryPlugin: { configuredSlot: null, enabled: false, registryLoaded: true },
        },
        memoryValidation: {
          agentId: "main",
          ok: false,
          summary: { errors: 1, warnings: 0, info: 0 },
          findings: [],
        },
        memoryRepairPreview: {
          agentId: "main",
          dryRun: true,
          ok: false,
          validation: { errors: 1, warnings: 0, info: 0 },
          summary: { proposals: 1, supported: 1, blocked: 0 },
          proposals: [
            {
              id: "proposal-secret-path",
              area: "session-memory",
              sourceCode: "sessionMemory.memoryDir.missing",
              severity: "error",
              action: "create_file",
              description: "Create the missing session memory file",
              targetPath: secretPath,
              dryRun: true,
              wouldMutate: true,
              requiresOperatorWrite: true,
              supported: true,
            },
          ],
        },
        onCallMethodChange: () => undefined,
        onCallParamsChange: () => undefined,
        onRefresh: () => undefined,
        onCall: () => undefined,
      }),
    );

    expect(text).toContain("[path:transcript-secret.md]");
    expect(text).not.toContain(secretPath);
    expect(text).not.toContain("/private/fased/workspaces/customer-alpha");
    expectNoMemoryDoctorTranscriptLeak(text, secretTranscript);
    vi.unstubAllGlobals();
  });

  it("snapshots memory doctor dashboard render contract as read-only redacted text", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    vi.stubGlobal("navigator", { language: "en-US" });
    const { renderDebug } = await import("./debug.ts");
    const secretWorkspace = "/private/fased/workspaces/customer-alpha";
    const secretPath = `${secretWorkspace}/memory/transcript-secret.md`;
    const secretTranscript = "SECRET_TRANSCRIPT_BODY should never render"; // pragma: allowlist secret
    const unsafeFields = {
      body: secretTranscript,
      transcript: secretTranscript,
      execute: "Execute repair",
      gatewayHandler: "doctor.memory.repair.execute",
      writePath: secretPath,
    };
    const text = normalizeRenderedText(
      flattenTemplateText(
        renderDebugForTest(renderDebug, {
          loading: false,
          status: {},
          health: {},
          models: [],
          heartbeat: {},
          eventLog: [],
          methods: ["status"],
          callMethod: "status",
          callParams: "{}",
          callResult: null,
          callError: null,
          memoryInventory: {
            agentId: "main",
            workspace: {
              path: secretWorkspace,
              exists: true,
              memoryRoots: [
                {
                  id: "memory-dir",
                  path: `${secretWorkspace}/memory`,
                  exists: true,
                  kind: "directory",
                  markdownFiles: 1,
                  ...unsafeFields,
                },
              ],
              ...unsafeFields,
            },
            backend: { configured: "builtin", citations: "auto", ...unsafeFields },
            qmd: { enabled: false, ...unsafeFields },
            sessionMemory: {
              hookConfigured: true,
              enabled: true,
              memoryDir: { path: secretPath, exists: false, kind: "missing", ...unsafeFields },
              ...unsafeFields,
            },
            memoryPlugin: {
              configuredSlot: null,
              enabled: false,
              registryLoaded: true,
              ...unsafeFields,
            },
            ...unsafeFields,
          },
          memoryValidation: {
            agentId: "main",
            ok: false,
            summary: { errors: 1, warnings: 2, info: 0 },
            findings: [
              {
                severity: "error",
                area: "session-memory",
                code: "sessionMemory.memoryDir.missing",
                message: "Session memory file is missing",
                path: secretPath,
                ...unsafeFields,
              },
            ],
            ...unsafeFields,
          },
          memoryRepairPreview: {
            agentId: "main",
            dryRun: true,
            ok: false,
            validation: { errors: 1, warnings: 2, info: 0 },
            summary: { proposals: 2, supported: 1, blocked: 1 },
            proposals: [
              {
                id: "proposal-secret-path",
                area: "session-memory",
                sourceCode: "sessionMemory.memoryDir.missing",
                severity: "error",
                action: "create_file",
                description: "Create the missing session memory file",
                targetPath: secretPath,
                dryRun: true,
                wouldMutate: true,
                requiresOperatorWrite: true,
                supported: true,
                ...unsafeFields,
              },
              {
                id: "proposal-review-config",
                area: "backend",
                sourceCode: "config.manual",
                severity: "warn",
                action: "review_config",
                description: "Review memory config manually",
                dryRun: true,
                wouldMutate: true,
                requiresOperatorWrite: true,
                supported: false,
                blockReason: "config mutation is not part of memory repair preview",
                ...unsafeFields,
              },
            ],
            ...unsafeFields,
          },
          onCallMethodChange: () => undefined,
          onCallParamsChange: () => undefined,
          onRefresh: () => undefined,
          onCall: () => undefined,
        }),
      ),
    );
    const memoryText = normalizeRenderedText(
      extractBetween(text, "Memory Repair Preview", "Task Ledger"),
    );

    expect(memoryText).toMatchInlineSnapshot(`
      "Memory Repair Preview Memory Doctor inventory, validation, and gated dry-run repairs. 1 errors v Memory Repair Preview Memory doctor inventory, validation, dry-run repair proposals, and gated execution. 2 proposals diagnostic dry-run gated writes explicit confirmation agent main workspace present 1 errors 2 warnings 1 supported 1 blocked Repair execution is write-capable and operator-only. It records backup, audit, and rollback metadata before applying supported proposals. Execute 1 supported repairs operator.admin backup + audit required create_file supported dry-run error Create the missing session memory file · [path:transcript-secret.md] proposal-secret-path review_config blocked warn Review memory config manually · config mutation is not part of memory repair preview proposal-review-config"
    `);
    expect(memoryText).toContain("[path:transcript-secret.md]");
    expect(memoryText).not.toContain(secretPath);
    expect(memoryText).not.toContain(secretWorkspace);
    expectNoMemoryDoctorTranscriptLeak(memoryText, secretTranscript);
    expect(memoryText).toContain("Execute 1 supported repairs");
    expect(memoryText).not.toContain("doctor.memory.repair.execute");
    expect(memoryText).not.toMatch(/transcript body|message body/i);
    vi.unstubAllGlobals();
  });
});
