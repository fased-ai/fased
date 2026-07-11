#!/usr/bin/env node

import module from "node:module";
import { fileURLToPath } from "node:url";
import { reexecWithSupportedNodeIfNeeded } from "./scripts/fased-launcher-runtime.mjs";

reexecWithSupportedNodeIfNeeded({ selfPath: fileURLToPath(import.meta.url) });

// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Ignore errors
  }
}

const isModuleNotFoundError = (err) =>
  err && typeof err === "object" && "code" in err && err.code === "ERR_MODULE_NOT_FOUND";

const installProcessWarningFilter = async () => {
  // Keep bootstrap warnings consistent with the TypeScript runtime.
  for (const specifier of ["./dist/warning-filter.js", "./dist/warning-filter.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.installProcessWarningFilter === "function") {
        mod.installProcessWarningFilter();
        return;
      }
    } catch (err) {
      if (isModuleNotFoundError(err)) {
        continue;
      }
      throw err;
    }
  }
};

await installProcessWarningFilter();

const tryImport = async (specifier) => {
  try {
    await import(specifier);
    return true;
  } catch (err) {
    // Only swallow missing-module errors; rethrow real runtime errors.
    if (isModuleNotFoundError(err)) {
      return false;
    }
    throw err;
  }
};

const lightweightCommand = `${process.argv[2] ?? ""} ${process.argv[3] ?? ""}`.trim();
const lightweightSpecifier =
  lightweightCommand === "update status"
    ? "./dist/light-update-status.js"
    : lightweightCommand === "plugins info"
      ? "./dist/light-plugin-info.js"
      : lightweightCommand === "plugins doctor"
        ? "./dist/light-plugin-doctor.js"
        : process.argv[2] === "update" &&
            (!process.argv[3] || process.argv[3] === "--json") &&
            process.argv.length <= 4
          ? "./dist/light-update-precheck.js"
          : null;

let handledByLightweightCli = false;
if (lightweightSpecifier) {
  try {
    const mod = await import(lightweightSpecifier);
    handledByLightweightCli = (await mod.run(process.argv)) === true;
  } catch (err) {
    if (!isModuleNotFoundError(err)) {
      throw err;
    }
  }
}

if (handledByLightweightCli) {
  // The dedicated status entrypoint avoids loading the full CLI graph.
} else if (await tryImport("./dist/entry.js")) {
  // OK
} else if (await tryImport("./dist/entry.mjs")) {
  // OK
} else {
  throw new Error("fased: missing dist/entry.(m)js (build output).");
}
