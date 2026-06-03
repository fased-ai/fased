import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeMemoryRepairExecutionRequestFixture } from "./repair-contract.test-fixtures.js";
import {
  evaluateMemoryRepairExecutionRequest,
  type DoctorMemoryRepairExecutionResponse,
} from "./repair-execution-request-contract.js";
import {
  evaluateMemoryRepairFsSafety,
  type DoctorMemoryRepairFsNodeState,
  type DoctorMemoryRepairFsPathState,
} from "./repair-executor-fs-safety-contract.js";

const ROOT = "/tmp/fased-memory-fs-safety-contract";

function makeAdmittedResponse(): DoctorMemoryRepairExecutionResponse {
  return evaluateMemoryRepairExecutionRequest(
    makeMemoryRepairExecutionRequestFixture({ root: ROOT }),
  );
}

function directoryState(value: string): DoctorMemoryRepairFsPathState {
  return { path: value, kind: "directory", realPath: value };
}

function fileState(value: string): DoctorMemoryRepairFsPathState {
  return { path: value, kind: "file", realPath: value, linkCount: 1 };
}

function missingState(
  value: string,
  parent: DoctorMemoryRepairFsNodeState = directoryState(path.dirname(value)),
): DoctorMemoryRepairFsPathState {
  return { path: value, kind: "missing", parent };
}

function makeSafePathStates(
  response: DoctorMemoryRepairExecutionResponse,
): DoctorMemoryRepairFsPathState[] {
  const plan = response.auditPlan;
  if (!plan) {
    throw new Error("fixture response missing audit plan");
  }
  const snapshotRoot = path.dirname(plan.backup.manifestPath);
  return [
    fileState(plan.backup.entries[0]?.targetPath ?? path.join(ROOT, "MEMORY.md")),
    directoryState(plan.backup.root),
    missingState(plan.backup.manifestPath, directoryState(snapshotRoot)),
    missingState(
      plan.backup.entries[0]?.snapshotPath ?? path.join(snapshotRoot, "missing.snapshot"),
      directoryState(snapshotRoot),
    ),
    directoryState(plan.audit.root),
    missingState(plan.audit.recordPath, directoryState(plan.audit.root)),
  ];
}

describe("memory repair fs safety contract", () => {
  it("admits a safe dry-run fs plan without touching the filesystem", () => {
    const response = makeAdmittedResponse();
    const decision = evaluateMemoryRepairFsSafety({
      auditPlan: response.auditPlan!,
      pathStates: makeSafePathStates(response),
    });

    expect(decision).toMatchObject({
      ok: true,
      safeToOpen: true,
      dryRun: true,
      noWritePerformed: true,
      reasons: [],
    });
    expect(decision.checkedPaths.map((entry) => entry.role)).toEqual([
      "backup-root",
      "backup-manifest",
      "audit-root",
      "audit-record",
      "target",
      "snapshot",
    ]);
  });

  it("denies planned paths without read-only file metadata", () => {
    const response = makeAdmittedResponse();
    const plan = response.auditPlan!;
    const states = makeSafePathStates(response).filter(
      (entry) => entry.path !== plan.backup.entries[0]?.targetPath,
    );

    const decision = evaluateMemoryRepairFsSafety({ auditPlan: plan, pathStates: states });

    expect(decision.ok).toBe(false);
    expect(decision.reasons).toContain("target path requires read-only file-system metadata");
  });

  it("denies symlinks, hardlinks, and device-like file types", () => {
    const response = makeAdmittedResponse();
    const plan = response.auditPlan!;
    const states = makeSafePathStates(response).map((entry) => {
      if (entry.path === plan.backup.entries[0]?.targetPath) {
        return { ...entry, kind: "symlink" as const };
      }
      if (entry.path === plan.backup.root) {
        return { ...entry, kind: "file" as const, linkCount: 2 };
      }
      if (entry.path === plan.audit.root) {
        return { ...entry, kind: "socket" as const };
      }
      return entry;
    });

    const decision = evaluateMemoryRepairFsSafety({ auditPlan: plan, pathStates: states });

    expect(decision.ok).toBe(false);
    expect(decision.reasons).toContain("target path has unsafe file type: symlink");
    expect(decision.reasons).toContain("backup-root path has multiple hard links");
    expect(decision.reasons).toContain(
      "backup-root path must be a directory or safely creatable directory",
    );
    expect(decision.reasons).toContain("audit-root path has unsafe file type: socket");
  });

  it("denies real paths and parents outside allowed roots", () => {
    const response = makeAdmittedResponse();
    const plan = response.auditPlan!;
    const states = makeSafePathStates(response).map((entry) => {
      if (entry.path === plan.backup.entries[0]?.targetPath) {
        return { ...entry, realPath: "/etc/passwd" };
      }
      if (entry.path === plan.audit.recordPath) {
        return {
          ...entry,
          parent: { path: "/etc", kind: "directory" as const, realPath: "/etc" },
        };
      }
      return entry;
    });

    const decision = evaluateMemoryRepairFsSafety({ auditPlan: plan, pathStates: states });

    expect(decision.ok).toBe(false);
    expect(decision.reasons).toContain("target real path is outside allowed roots");
    expect(decision.reasons).toContain("audit-record parent real path is outside allowed roots");
    expect(decision.reasons).toContain("audit-record parent path is outside allowed roots");
  });

  it("denies pre-existing output files", () => {
    const response = makeAdmittedResponse();
    const plan = response.auditPlan!;
    const states = makeSafePathStates(response).map((entry) => {
      if (entry.path === plan.backup.manifestPath || entry.path === plan.audit.recordPath) {
        return fileState(entry.path);
      }
      return entry;
    });

    const decision = evaluateMemoryRepairFsSafety({ auditPlan: plan, pathStates: states });

    expect(decision.ok).toBe(false);
    expect(decision.reasons).toContain("backup-manifest output path must not already exist");
    expect(decision.reasons).toContain("audit-record output path must not already exist");
  });

  it("denies missing output paths with unsafe or absent parent metadata", () => {
    const response = makeAdmittedResponse();
    const plan = response.auditPlan!;
    const states = makeSafePathStates(response).map((entry) => {
      if (entry.path === plan.backup.manifestPath) {
        return { ...entry, parent: undefined };
      }
      if (entry.path === plan.audit.recordPath) {
        return { ...entry, parent: { path: path.dirname(entry.path), kind: "symlink" as const } };
      }
      return entry;
    });

    const decision = evaluateMemoryRepairFsSafety({ auditPlan: plan, pathStates: states });

    expect(decision.ok).toBe(false);
    expect(decision.reasons).toContain("backup-manifest missing path requires parent metadata");
    expect(decision.reasons).toContain("audit-record parent must be an existing directory");
    expect(decision.reasons).toContain("audit-record parent has unsafe file type: symlink");
  });

  it("denies tampered audit plans with redacted or outside-root paths", () => {
    const response = makeAdmittedResponse();
    const plan = {
      ...response.auditPlan!,
      backup: {
        ...response.auditPlan!.backup,
        entries: [
          {
            ...response.auditPlan!.backup.entries[0],
            targetPath: "[redacted:memory]",
            snapshotPath: "/var/tmp/outside.snapshot",
          },
        ],
      },
    };

    const decision = evaluateMemoryRepairFsSafety({
      auditPlan: plan,
      pathStates: [
        ...makeSafePathStates(response),
        missingState("/var/tmp/outside.snapshot", directoryState("/var/tmp")),
      ],
    });

    expect(decision.ok).toBe(false);
    expect(decision.reasons).toContain("target path must be absolute and non-redacted");
    expect(decision.reasons).toContain("target path is outside allowed roots");
    expect(decision.reasons).toContain("snapshot path is outside allowed roots");
  });
});
