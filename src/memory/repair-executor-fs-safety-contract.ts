import path from "node:path";
import type { DoctorMemoryRepairPreviewAction } from "./inventory.js";
import type { DoctorMemoryRepairExecutionAuditPlanRecord } from "./repair-audit-plan.js";

export type DoctorMemoryRepairFsNodeKind =
  | "missing"
  | "file"
  | "directory"
  | "symlink"
  | "fifo"
  | "socket"
  | "block-device"
  | "char-device"
  | "unknown";

export type DoctorMemoryRepairFsPathRole =
  | "target"
  | "backup-root"
  | "backup-manifest"
  | "snapshot"
  | "audit-root"
  | "audit-record";

export type DoctorMemoryRepairFsNodeState = {
  path: string;
  kind: DoctorMemoryRepairFsNodeKind;
  realPath?: string;
  linkCount?: number;
};

export type DoctorMemoryRepairFsPathState = DoctorMemoryRepairFsNodeState & {
  parent?: DoctorMemoryRepairFsNodeState;
};

export type DoctorMemoryRepairFsSafetyInput = {
  auditPlan: DoctorMemoryRepairExecutionAuditPlanRecord;
  pathStates: DoctorMemoryRepairFsPathState[];
};

export type DoctorMemoryRepairFsSafetyCheckedPath = {
  role: DoctorMemoryRepairFsPathRole;
  path: string;
  action?: DoctorMemoryRepairPreviewAction;
  ok: boolean;
  reasons: string[];
};

export type DoctorMemoryRepairFsSafetyDecision = {
  ok: boolean;
  safeToOpen: boolean;
  dryRun: true;
  noWritePerformed: true;
  checkedPaths: DoctorMemoryRepairFsSafetyCheckedPath[];
  reasons: string[];
};

type PlannedFsPath = {
  role: DoctorMemoryRepairFsPathRole;
  path: string;
  expectation: "directory" | "new-file" | "target";
  action?: DoctorMemoryRepairPreviewAction;
};

const UNSAFE_NODE_KINDS = new Set<DoctorMemoryRepairFsNodeKind>([
  "symlink",
  "fifo",
  "socket",
  "block-device",
  "char-device",
  "unknown",
]);

export function evaluateMemoryRepairFsSafety(
  input: DoctorMemoryRepairFsSafetyInput,
): DoctorMemoryRepairFsSafetyDecision {
  const stateByPath = new Map(
    input.pathStates.map((state) => [normalizePathKey(state.path), state]),
  );
  const plannedPaths = collectPlannedFsPaths(input.auditPlan);
  const checkedPaths = plannedPaths.map((planned) =>
    evaluatePlannedPath({
      planned,
      state: stateByPath.get(normalizePathKey(planned.path)),
      allowedRoots: input.auditPlan.allowedRoots,
    }),
  );
  const auditReasons = collectAuditPlanFsDenyReasons(input.auditPlan);
  const reasons = Array.from(
    new Set([...auditReasons, ...checkedPaths.flatMap((entry) => entry.reasons)]),
  );

  return {
    ok: reasons.length === 0,
    safeToOpen: reasons.length === 0,
    dryRun: true,
    noWritePerformed: true,
    checkedPaths,
    reasons,
  };
}

function collectPlannedFsPaths(
  auditPlan: DoctorMemoryRepairExecutionAuditPlanRecord,
): PlannedFsPath[] {
  const paths: PlannedFsPath[] = [
    {
      role: "backup-root",
      path: auditPlan.backup.root,
      expectation: "directory",
    },
    {
      role: "backup-manifest",
      path: auditPlan.backup.manifestPath,
      expectation: "new-file",
    },
    {
      role: "audit-root",
      path: auditPlan.audit.root,
      expectation: "directory",
    },
    {
      role: "audit-record",
      path: auditPlan.audit.recordPath,
      expectation: "new-file",
    },
  ];

  for (const entry of auditPlan.backup.entries) {
    paths.push({
      role: "target",
      path: entry.targetPath,
      expectation: "target",
      action: entry.action,
    });
    paths.push({
      role: "snapshot",
      path: entry.snapshotPath,
      expectation: "new-file",
      action: entry.action,
    });
  }

  return dedupePlannedPaths(paths);
}

function evaluatePlannedPath(params: {
  planned: PlannedFsPath;
  state: DoctorMemoryRepairFsPathState | undefined;
  allowedRoots: readonly string[];
}): DoctorMemoryRepairFsSafetyCheckedPath {
  const reasons: string[] = [];
  const { planned, state, allowedRoots } = params;

  if (!isAbsoluteSafePath(planned.path)) {
    reasons.push(`${planned.role} path must be absolute and non-redacted`);
  }
  if (!isPathWithinAnyRoot(planned.path, allowedRoots)) {
    reasons.push(`${planned.role} path is outside allowed roots`);
  }
  if (!state) {
    reasons.push(`${planned.role} path requires read-only file-system metadata`);
    return {
      role: planned.role,
      path: path.resolve(planned.path),
      ...(planned.action ? { action: planned.action } : {}),
      ok: false,
      reasons,
    };
  }

  reasons.push(...collectNodeDenyReasons(state, planned.role, allowedRoots));
  reasons.push(...collectExpectationDenyReasons(planned, state, allowedRoots));

  return {
    role: planned.role,
    path: path.resolve(planned.path),
    ...(planned.action ? { action: planned.action } : {}),
    ok: reasons.length === 0,
    reasons: Array.from(new Set(reasons)),
  };
}

function collectAuditPlanFsDenyReasons(
  auditPlan: DoctorMemoryRepairExecutionAuditPlanRecord,
): string[] {
  const reasons: string[] = [];
  if (!auditPlan.dryRun || !auditPlan.noWritePerformed) {
    reasons.push("memory repair fs safety contract requires pre-execution dry-run input");
  }
  if (auditPlan.transcriptAccess !== "none" || auditPlan.bodyAccess !== "none") {
    reasons.push("memory repair fs safety requires no transcript or body access");
  }
  if (!auditPlan.allowedRoots.length) {
    reasons.push("memory repair fs safety requires allowed roots");
  }
  return reasons;
}

function collectExpectationDenyReasons(
  planned: PlannedFsPath,
  state: DoctorMemoryRepairFsPathState,
  allowedRoots: readonly string[],
): string[] {
  switch (planned.expectation) {
    case "directory":
      return collectDirectoryExpectationDenyReasons(planned, state, allowedRoots);
    case "new-file":
      return collectNewFileExpectationDenyReasons(planned, state, allowedRoots);
    case "target":
      return collectTargetExpectationDenyReasons(planned, state, allowedRoots);
  }
}

function collectDirectoryExpectationDenyReasons(
  planned: PlannedFsPath,
  state: DoctorMemoryRepairFsPathState,
  allowedRoots: readonly string[],
): string[] {
  if (state.kind === "directory") {
    return [];
  }
  if (state.kind === "missing") {
    return collectMissingPathParentDenyReasons(planned.role, state, allowedRoots);
  }
  return [`${planned.role} path must be a directory or safely creatable directory`];
}

function collectNewFileExpectationDenyReasons(
  planned: PlannedFsPath,
  state: DoctorMemoryRepairFsPathState,
  allowedRoots: readonly string[],
): string[] {
  if (state.kind !== "missing") {
    return [`${planned.role} output path must not already exist`];
  }
  return collectMissingPathParentDenyReasons(planned.role, state, allowedRoots);
}

function collectTargetExpectationDenyReasons(
  planned: PlannedFsPath,
  state: DoctorMemoryRepairFsPathState,
  allowedRoots: readonly string[],
): string[] {
  switch (planned.action) {
    case "create_directory":
      if (state.kind === "directory") {
        return [];
      }
      if (state.kind === "missing") {
        return collectMissingPathParentDenyReasons(planned.role, state, allowedRoots);
      }
      return ["target path must be a directory or safely creatable directory"];
    case "create_file":
    case "rebuild_index":
      if (state.kind === "file") {
        return [];
      }
      if (state.kind === "missing") {
        return collectMissingPathParentDenyReasons(planned.role, state, allowedRoots);
      }
      return ["target path must be a file or safely creatable file"];
    default:
      return ["target action is not executable by the fs safety contract"];
  }
}

function collectNodeDenyReasons(
  state: DoctorMemoryRepairFsPathState,
  role: DoctorMemoryRepairFsPathRole,
  allowedRoots: readonly string[],
): string[] {
  const reasons: string[] = [];
  if (!isAbsoluteSafePath(state.path)) {
    reasons.push(`${role} metadata path must be absolute and non-redacted`);
  }
  if (UNSAFE_NODE_KINDS.has(state.kind)) {
    reasons.push(`${role} path has unsafe file type: ${state.kind}`);
  }
  if (state.kind === "file" && typeof state.linkCount === "number" && state.linkCount > 1) {
    reasons.push(`${role} path has multiple hard links`);
  }
  if (state.realPath && !isPathWithinAnyRoot(state.realPath, allowedRoots)) {
    reasons.push(`${role} real path is outside allowed roots`);
  }
  return reasons;
}

function collectMissingPathParentDenyReasons(
  role: DoctorMemoryRepairFsPathRole,
  state: DoctorMemoryRepairFsPathState,
  allowedRoots: readonly string[],
): string[] {
  const reasons: string[] = [];
  if (!state.parent) {
    return [`${role} missing path requires parent metadata`];
  }
  if (!isAbsoluteSafePath(state.parent.path)) {
    reasons.push(`${role} parent path must be absolute and non-redacted`);
  }
  if (state.parent.kind !== "directory") {
    reasons.push(`${role} parent must be an existing directory`);
  }
  if (UNSAFE_NODE_KINDS.has(state.parent.kind)) {
    reasons.push(`${role} parent has unsafe file type: ${state.parent.kind}`);
  }
  if (state.parent.realPath && !isPathWithinAnyRoot(state.parent.realPath, allowedRoots)) {
    reasons.push(`${role} parent real path is outside allowed roots`);
  }
  if (!isPathWithinAnyRoot(state.parent.path, allowedRoots)) {
    reasons.push(`${role} parent path is outside allowed roots`);
  }
  return reasons;
}

function dedupePlannedPaths(paths: PlannedFsPath[]): PlannedFsPath[] {
  const seen = new Set<string>();
  const deduped: PlannedFsPath[] = [];
  for (const entry of paths) {
    const key = `${entry.role}:${normalizePathKey(entry.path)}:${entry.action ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function normalizePathKey(value: string): string {
  return path.resolve(value);
}

function isAbsoluteSafePath(value: string): boolean {
  return Boolean(value) && path.isAbsolute(value) && !value.startsWith("[redacted:");
}

function isPathWithinAnyRoot(candidate: string, roots: readonly string[]): boolean {
  if (!isAbsoluteSafePath(candidate)) {
    return false;
  }
  const resolvedCandidate = path.resolve(candidate);
  return roots.some((root) => {
    if (!isAbsoluteSafePath(root)) {
      return false;
    }
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}
