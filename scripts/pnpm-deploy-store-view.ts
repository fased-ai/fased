import { lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";

const writableStoreEntries = new Set(["projects", "tmp"]);

export function createWritablePnpmDeployStoreView(sourceStore: string, parent: string): string {
  const canonicalSource = realpathSync(sourceStore);
  const sourceMetadata = lstatSync(canonicalSource);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error("pnpm source store must resolve to a directory");
  }

  const view = path.join(parent, "pnpm-deploy-store");
  const versionedView = path.join(view, path.basename(canonicalSource));
  mkdirSync(versionedView, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(canonicalSource, { withFileTypes: true })) {
    const destination = path.join(versionedView, entry.name);
    if (writableStoreEntries.has(entry.name)) {
      mkdirSync(destination, { mode: 0o700 });
      continue;
    }
    if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) {
      throw new Error(`unsupported pnpm store entry: ${entry.name}`);
    }
    symlinkSync(
      path.join(canonicalSource, entry.name),
      destination,
      entry.isDirectory() ? "dir" : "file",
    );
  }
  return view;
}
