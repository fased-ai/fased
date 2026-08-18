import { createRequire } from "node:module";
import { installProcessWarningFilter } from "./warning-filter.js";

const require = createRequire(import.meta.url);

/**
 * Load the built-in synchronous SQLite bindings with the same actionable error
 * used by the memory subsystem. Keeping this in infra lets state stores share
 * the runtime boundary without taking a dependency on memory.
 */
export function requireNodeSqlite(): typeof import("node:sqlite") {
  installProcessWarningFilter();
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`,
      { cause: err },
    );
  }
}
