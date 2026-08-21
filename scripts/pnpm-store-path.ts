type WorkspaceModulesMetadata = { storeDir?: unknown };

export function selectPnpmStorePath(params: {
  reported: string;
  workspaceModulesMetadata: string;
}): string {
  const reported = params.reported.trim();
  if (reported) {
    if (!reported.startsWith("/")) {
      throw new Error("pnpm store path is not absolute");
    }
    return reported;
  }

  let metadata: WorkspaceModulesMetadata;
  try {
    metadata = JSON.parse(params.workspaceModulesMetadata) as WorkspaceModulesMetadata;
  } catch (error) {
    throw new Error("pnpm store path output is empty and workspace metadata is invalid", {
      cause: error,
    });
  }
  const storeDir = typeof metadata.storeDir === "string" ? metadata.storeDir.trim() : "";
  if (!storeDir || !storeDir.startsWith("/")) {
    throw new Error("pnpm store path output is empty and workspace storeDir is not absolute");
  }
  return storeDir;
}
