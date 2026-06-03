export type DoctorMemoryRepairContractIndexEntry = {
  id:
    | "execution-policy"
    | "audit-plan"
    | "execution-request"
    | "cli-preview"
    | "dashboard-preview"
    | "executor-lock"
    | "fs-safety"
    | "execution-result"
    | "preflight-pipeline"
    | "preflight-cli-preview"
    | "preflight-dashboard-preview"
    | "executor-gate";
  modulePath: string;
  purpose: string;
  boundary: string;
};

export const DOCTOR_MEMORY_REPAIR_CONTRACT_INDEX = [
  {
    id: "execution-policy",
    modulePath: "src/memory/repair-execution-policy.ts",
    purpose: "Pure admission decision for a future repair execution request.",
    boundary: "No gateway registration, CLI route, dashboard action, executor, or writes.",
  },
  {
    id: "audit-plan",
    modulePath: "src/memory/repair-audit-plan.ts",
    purpose: "Dry-run backup, audit, and rollback record plan for admitted proposals.",
    boundary: "No backup directory, audit record, rollback file, executor, or writes.",
  },
  {
    id: "execution-request",
    modulePath: "src/memory/repair-execution-request-contract.ts",
    purpose: "Closed dry-run request and response envelope for doctor.memory.repair.execute.",
    boundary: "No gateway handler, method registration, executor, or writes.",
  },
  {
    id: "cli-preview",
    modulePath: "src/memory/repair-cli-preview-contract.ts",
    purpose: "CLI-safe formatter for admitted or denied dry-run repair responses.",
    boundary: "No CLI command registration, executor, full-path default, or writes.",
  },
  {
    id: "dashboard-preview",
    modulePath: "src/memory/repair-dashboard-preview-contract.ts",
    purpose: "Dashboard-safe view model with redacted rows and disabled repair action.",
    boundary: "No dashboard execute route, enabled action, gateway handler, executor, or writes.",
  },
  {
    id: "executor-lock",
    modulePath: "src/memory/repair-executor-lock-contract.ts",
    purpose: "Pure single-flight and idempotency contract for a future executor.",
    boundary: "No durable lock file, gateway handler, executor, or writes.",
  },
  {
    id: "fs-safety",
    modulePath: "src/memory/repair-executor-fs-safety-contract.ts",
    purpose: "Pure file-system safety decision over caller-supplied read-only path metadata.",
    boundary: "No lstat, realpath, open, lock file, executor, or writes.",
  },
  {
    id: "execution-result",
    modulePath: "src/memory/repair-executor-result-contract.ts",
    purpose: "Future success, failure, and partial-write result schema.",
    boundary: "No result writer, audit append, rollback execution, executor, or writes.",
  },
  {
    id: "preflight-pipeline",
    modulePath: "src/memory/repair-preflight-pipeline-contract.ts",
    purpose: "Pure ordering contract for policy, audit plan, lock, FS safety, and result.",
    boundary: "No file probes, lock persistence, gateway handler, executor, or writes.",
  },
  {
    id: "preflight-cli-preview",
    modulePath: "src/memory/repair-preflight-cli-preview-contract.ts",
    purpose: "CLI/admin-safe formatter for dry-run preflight pipeline decisions.",
    boundary: "No CLI command registration, gateway handler, executor, or writes.",
  },
  {
    id: "preflight-dashboard-preview",
    modulePath: "src/memory/repair-preflight-dashboard-preview-contract.ts",
    purpose: "Dashboard-safe view model for dry-run preflight pipeline decisions.",
    boundary: "No dashboard route, execute action, gateway handler, executor, or writes.",
  },
  {
    id: "executor-gate",
    modulePath: "src/memory/repair-executor-gate.ts",
    purpose: "Pure final gate for any future repair executor after preflight admission.",
    boundary: "No file mutation, gateway handler, CLI route, dashboard action, or writes.",
  },
] as const satisfies readonly DoctorMemoryRepairContractIndexEntry[];

export type DoctorMemoryRepairContractId =
  (typeof DOCTOR_MEMORY_REPAIR_CONTRACT_INDEX)[number]["id"];

export * from "./repair-audit-plan.js";
export * from "./repair-cli-preview-contract.js";
export * from "./repair-dashboard-preview-contract.js";
export * from "./repair-execution-policy.js";
export * from "./repair-execution-request-contract.js";
export * from "./repair-executor-fs-safety-contract.js";
export * from "./repair-executor-gate.js";
export * from "./repair-executor-lock-contract.js";
export * from "./repair-executor-result-contract.js";
export * from "./repair-preflight-cli-preview-contract.js";
export * from "./repair-preflight-dashboard-preview-contract.js";
export * from "./repair-preflight-pipeline-contract.js";
