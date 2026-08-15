import { readFileSync } from "node:fs";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { DebugState } from "../../ui/src/ui/controllers/debug.ts";
import { registerMemoryCli } from "../cli/memory-cli.js";
import { findRoutedCommand } from "../cli/program/routes.js";
import {
  ADMIN_SCOPE,
  READ_SCOPE,
  authorizeOperatorScopesForMethod,
  isGatewayMethodClassified,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "../gateway/method-scopes.js";
import { listGatewayMethods } from "../gateway/server-methods-list.js";
import { coreGatewayHandlers } from "../gateway/server-methods.js";
import { doctorHandlers } from "../gateway/server-methods/doctor.js";
import { DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD } from "./repair-execution-request-contract.js";

const LIVE_MEMORY_DOCTOR_RPC_SURFACES = [
  "doctor.memory.status",
  "doctor.memory.inventory",
  "doctor.memory.validate",
  "doctor.memory.repair.preview",
  "doctor.memory.wiki.status",
] as const;

const LIVE_MEMORY_DOCTOR_ADMIN_SURFACES = [
  DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
  "doctor.memory.wiki.rebuild",
] as const;

const CLOSED_MEMORY_DOCTOR_WRITE_SURFACES = [
  "doctor.memory.repair.preflight",
  "doctor.memory.repair.preflight.pipeline",
  "doctor.memory.repair.preflight.cli-preview",
  "doctor.memory.repair.preflight.dashboard-preview",
  "doctor.memory.dreamDiary",
  "doctor.memory.backfillDreamDiary",
  "doctor.memory.resetDreamDiary",
  "doctor.memory.resetGroundedShortTerm",
  "doctor.memory.repairDreamingArtifacts",
  "doctor.memory.dedupeDreamDiary",
] as const;

describe("memory repair read-only surface inventory", () => {
  it("keeps the live gateway Memory Doctor RPC inventory read-only", () => {
    const listedMethods = listGatewayMethods();

    expect(listedMethods.filter((method) => method.startsWith("doctor.memory."))).toEqual([
      "doctor.memory.inventory",
      DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
      "doctor.memory.repair.preview",
      "doctor.memory.status",
      "doctor.memory.validate",
      "doctor.memory.wiki.rebuild",
      "doctor.memory.wiki.status",
    ]);

    for (const method of LIVE_MEMORY_DOCTOR_RPC_SURFACES) {
      expect(listedMethods).toContain(method);
      expect(isGatewayMethodClassified(method)).toBe(true);
      expect(resolveLeastPrivilegeOperatorScopesForMethod(method)).toEqual([READ_SCOPE]);
      expect(authorizeOperatorScopesForMethod(method, [READ_SCOPE])).toMatchObject({
        allowed: true,
      });
      expect(coreGatewayHandlers[method]).toBeTypeOf("function");
      expect(doctorHandlers[method]).toBeTypeOf("function");
    }

    for (const method of LIVE_MEMORY_DOCTOR_ADMIN_SURFACES) {
      expect(listedMethods).toContain(method);
      expect(isGatewayMethodClassified(method)).toBe(true);
      expect(resolveLeastPrivilegeOperatorScopesForMethod(method)).toEqual([ADMIN_SCOPE]);
      expect(authorizeOperatorScopesForMethod(method, [READ_SCOPE])).toMatchObject({
        allowed: false,
      });
      expect(authorizeOperatorScopesForMethod(method, [ADMIN_SCOPE])).toMatchObject({
        allowed: true,
      });
      expect(coreGatewayHandlers[method]).toBeTypeOf("function");
      expect(doctorHandlers[method]).toBeTypeOf("function");
    }
  });

  it("keeps preflight and upstream mutating RPC surfaces closed", () => {
    const listedMethods = listGatewayMethods();

    for (const method of CLOSED_MEMORY_DOCTOR_WRITE_SURFACES) {
      expect(listedMethods).not.toContain(method);
      expect(isGatewayMethodClassified(method)).toBe(false);
      expect(resolveLeastPrivilegeOperatorScopesForMethod(method)).toEqual([]);
      expect(authorizeOperatorScopesForMethod(method, [READ_SCOPE])).toMatchObject({
        allowed: false,
      });
      expect(coreGatewayHandlers[method]).toBeUndefined();
      expect(doctorHandlers[method]).toBeUndefined();
    }
  });

  it("keeps the CLI doctor command read-only and exposes repair execution as a gated subcommand", async () => {
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);

    const memoryCommand = program.commands.find((command) => command.name() === "memory");
    expect(memoryCommand).toBeTruthy();
    const subcommands = memoryCommand?.commands.map((command) => command.name()) ?? [];
    expect(subcommands).toContain("doctor");
    expect(subcommands).toContain("repair");
    expect(subcommands).not.toContain("execute");
    expect(subcommands).not.toContain("preflight");

    const doctorCommand = memoryCommand?.commands.find((command) => command.name() === "doctor");
    expect(doctorCommand).toBeTruthy();
    const doctorFlags = doctorCommand?.options.map((option) => option.flags).join(" ") ?? "";
    expect(doctorFlags).toContain("--agent <id>");
    expect(doctorFlags).toContain("--json");
    expect(doctorFlags).not.toMatch(/--(?:apply|execute|preflight|repair|write|yes)\b/);

    const repairCommand = memoryCommand?.commands.find((command) => command.name() === "repair");
    expect(repairCommand).toBeTruthy();
    const repairSubcommands = repairCommand?.commands.map((command) => command.name()) ?? [];
    expect(repairSubcommands).toContain("execute");
    const executeFlags =
      repairCommand?.commands
        .find((command) => command.name() === "execute")
        ?.options.map((option) => option.flags)
        .join(" ") ?? "";
    expect(executeFlags).toContain("--proposal-id <id>");
    expect(executeFlags).toContain("--yes");

    const routedDoctor = findRoutedCommand(["memory", "doctor"]);
    expect(routedDoctor).toBeTruthy();
    await expect(routedDoctor?.run(["node", "fased", "memory", "doctor", "execute"])).resolves.toBe(
      false,
    );
    await expect(
      routedDoctor?.run(["node", "fased", "memory", "doctor", "--agent", "main", "repair"]),
    ).resolves.toBe(false);
    await expect(
      routedDoctor?.run(["node", "fased", "memory", "doctor", "preflight"]),
    ).resolves.toBe(false);
    expect(findRoutedCommand(["memory", "preflight"])).toBeNull();
  });

  it("keeps the dashboard Memory Doctor surface on read-only RPC calls", async () => {
    const { loadDebug } = await import("../../ui/src/ui/controllers/debug.ts");
    const requests: string[] = [];
    const request = vi.fn(async (method: string) => {
      requests.push(method);
      switch (method) {
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
            ok: true,
            summary: { errors: 0, warnings: 0, info: 0 },
            findings: [],
          };
        case "doctor.memory.repair.preview":
          return {
            agentId: "main",
            dryRun: true,
            ok: true,
            validation: { errors: 0, warnings: 0, info: 0 },
            summary: { proposals: 0, supported: 0, blocked: 0 },
            proposals: [],
          };
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
        default:
          return {};
      }
    });
    const state = createDebugState(request);

    await loadDebug(state);

    expect(requests.filter((method) => method.startsWith("doctor.memory."))).toEqual([
      "doctor.memory.inventory",
      "doctor.memory.validate",
      "doctor.memory.repair.preview",
    ]);
    for (const method of CLOSED_MEMORY_DOCTOR_WRITE_SURFACES) {
      expect(requests).not.toContain(method);
    }
    expect(state.debugMemoryRepairPreview?.dryRun).toBe(true);

    function createDebugState(requestFn: typeof request): DebugState {
      return {
        client: { request: requestFn } as unknown as DebugState["client"],
        connected: true,
        debugLoading: false,
        debugStatus: null,
        debugHealth: null,
        debugModels: [],
        debugModelCatalogStatus: null,
        debugCommandsCatalog: null,
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
      } as unknown as DebugState;
    }
  });

  it("documents the live surface inventory and gated execution boundary", () => {
    const doc = readFileSync("docs/concepts/memory-doctor.md", "utf-8");
    const cliDoc = readFileSync("docs/cli/memory.md", "utf-8");

    expect(doc).toContain("## Live Surface Inventory");
    for (const method of LIVE_MEMORY_DOCTOR_RPC_SURFACES) {
      expect(doc).toContain(method);
    }
    expect(doc).toContain("fased memory doctor");
    expect(doc).toContain("Memory Repair Preview");
    expect(doc).toContain("fased memory repair execute --proposal-id <id> --yes");
    expect(doc).toContain("The internal preflight contracts are still not separate live surfaces.");
    expect(doc).toContain(
      "`doctor.memory.repair.execute` and `doctor.memory.wiki.rebuild` are the only",
    );
    expect(doc).toContain("## Regression Coverage");
    expect(doc).toContain("src/memory/memory-doctor-readonly-test-helpers.ts");
    expect(doc).toContain("src/memory/memory-doctor-readonly-test-helpers.test.ts");
    expect(doc).toContain("shape merger, or transcript/body checks");
    expect(doc).toContain("forbidden-field, JSON-shape");
    expect(doc).toContain("src/memory/repair-readonly-surface-inventory.test.ts");
    expect(doc).toContain("src/memory/repair-preview-schema-snapshot.test.ts");
    expect(doc).toContain("src/memory/repair-preview-redaction-regression.test.ts");
    expect(doc).toContain("src/cli/memory-cli.test.ts");
    expect(doc).toContain("including inventory and validation sections");
    expect(doc).toContain("snapshots the full JSON envelope shape");
    expect(doc).toContain("ui/src/ui/views/debug.test.ts");
    expect(doc).toContain("snapshots the visible gated-execute");
    expect(doc).toContain("ui/src/ui/controllers/debug.test.ts");
    expect(doc).toContain("strips unsafe transcript/body or");
    expect(doc).toContain("each report contains only `agentId`,");
    expect(cliDoc).toContain('"reports"');
    expect(cliDoc).toContain('"inventory"');
    expect(cliDoc).toContain('"validation"');
    expect(cliDoc).toContain('"repairPreview"');
    expect(cliDoc).toContain(
      "fased memory repair execute --proposal-id memory-repair-preview-1 --yes",
    );
    expect(cliDoc).toContain("request params");
    expect(cliDoc).toContain("write-capable action");
    expect(cliDoc).toContain("requires `--yes`");
  });
});
