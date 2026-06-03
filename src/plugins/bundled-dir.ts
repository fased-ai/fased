import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFasedAgentPackageRootSync } from "../infra/fased-root.js";

export type BundledPluginsResolveOptions = {
  argv1?: string;
  moduleUrl?: string;
  cwd?: string;
  execPath?: string;
};

function looksLikeBundledPluginsDir(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const pluginRoot = path.join(dir, entry.name);
      if (fs.existsSync(path.join(pluginRoot, "fased.plugin.json"))) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function resolveBundledPluginsDir(
  opts: BundledPluginsResolveOptions = {},
): string | undefined {
  const override = process.env.FASED_BUNDLED_PLUGINS_DIR?.trim();
  if (override) {
    return override;
  }

  // bun --compile: ship a sibling `extensions/` next to the executable.
  try {
    const execDir = path.dirname(opts.execPath ?? process.execPath);
    const sibling = path.join(execDir, "extensions");
    if (looksLikeBundledPluginsDir(sibling)) {
      return sibling;
    }
  } catch {
    // ignore
  }

  // npm/dev: resolve the package root first. This keeps shared chunks under
  // dist/plugin-sdk from missing the package-level bundled extensions.
  try {
    const moduleUrl = opts.moduleUrl ?? import.meta.url;
    const packageRoot = resolveFasedAgentPackageRootSync({
      argv1: opts.argv1 ?? process.argv[1],
      moduleUrl,
      cwd: opts.cwd ?? process.cwd(),
    });
    if (packageRoot) {
      const bundled = path.join(packageRoot, "extensions");
      if (looksLikeBundledPluginsDir(bundled)) {
        return bundled;
      }
    }

    // Fallback for unusual layouts: walk up from this module to find
    // `extensions/` at the package root.
    let cursor = path.dirname(fileURLToPath(moduleUrl));
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(cursor, "extensions");
      if (looksLikeBundledPluginsDir(candidate)) {
        return candidate;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  } catch {
    // ignore
  }

  return undefined;
}
