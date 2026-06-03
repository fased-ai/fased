import path from "node:path";

function resolvePathForPlatform(value: string): string {
  return process.platform === "win32" ? path.win32.resolve(value) : path.resolve(value);
}

function relativePathForPlatform(root: string, candidate: string): string {
  return process.platform === "win32"
    ? path.win32.relative(root.toLowerCase(), candidate.toLowerCase())
    : path.relative(root, candidate);
}

function isAbsoluteForPlatform(value: string): boolean {
  return process.platform === "win32" ? path.win32.isAbsolute(value) : path.isAbsolute(value);
}

export function toRelativeWorkspacePath(workspaceRoot: string, absolutePath: string): string {
  const rootResolved = resolvePathForPlatform(workspaceRoot);
  const resolved = resolvePathForPlatform(absolutePath);
  const relative = relativePathForPlatform(rootResolved, resolved);
  if (
    !relative ||
    relative === "." ||
    relative.startsWith("..") ||
    isAbsoluteForPlatform(relative)
  ) {
    throw new Error(`Path escapes workspace root (${workspaceRoot}): ${absolutePath}`);
  }
  return relative;
}
