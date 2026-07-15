#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function realpathOrEmpty(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return "";
  }
}

function lstatOrNull(value) {
  try {
    return fs.lstatSync(value);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isInstallerOwnedAlias({ aliasPath, sourceLauncher, target, stat }) {
  if (stat.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(aliasPath);
    const aliasReal = realpathOrEmpty(aliasPath);
    const sourceReal = sourceLauncher ? realpathOrEmpty(sourceLauncher) : "";
    const targetReal = realpathOrEmpty(target);
    return (
      linkTarget === target ||
      (sourceLauncher && linkTarget === sourceLauncher) ||
      (targetReal && aliasReal === targetReal) ||
      (sourceReal && aliasReal === sourceReal) ||
      linkTarget.endsWith("/.fased/install-cache/npm-global/bin/fased")
    );
  }
  if (!stat.isFile() || !sourceLauncher) {
    return false;
  }
  const content = fs.readFileSync(aliasPath, "utf8");
  return content.includes(sourceLauncher) && content.includes("exec ");
}

export function reconcileManagedCliAlias({ target, sourceLauncher, aliasPath }) {
  fs.accessSync(target, fs.constants.X_OK);
  fs.mkdirSync(path.dirname(aliasPath), { recursive: true });

  const existing = lstatOrNull(aliasPath);
  if (existing) {
    const aliasReal = realpathOrEmpty(aliasPath);
    const targetReal = realpathOrEmpty(target);
    if (targetReal && aliasReal === targetReal) {
      return { status: "current", aliasPath, target };
    }
    if (!isInstallerOwnedAlias({ aliasPath, sourceLauncher, target, stat: existing })) {
      return { status: "preserved", aliasPath, target };
    }
    fs.rmSync(aliasPath, { force: true });
  }

  fs.symlinkSync(target, aliasPath);
  return { status: "updated", aliasPath, target };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg ?? ""}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    values.set(arg, value);
    index += 1;
  }
  const target = values.get("--target");
  if (!target) {
    throw new Error("--target is required");
  }
  return {
    target,
    sourceLauncher: values.get("--source-launcher") ?? "",
    aliasPath:
      values.get("--alias") ??
      process.env.FASED_MANAGED_CLI_ALIAS ??
      path.join(os.homedir(), ".local", "bin", "fased"),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = reconcileManagedCliAlias(parseArgs(process.argv.slice(2)));
    if (result.status === "preserved") {
      process.stderr.write(
        `Keeping user-managed Fased command at ${result.aliasPath}; managed CLI remains at ${result.target}.\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
