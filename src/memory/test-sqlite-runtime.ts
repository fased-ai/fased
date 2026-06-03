import { createRequire } from "node:module";
import { describe } from "vitest";

const require = createRequire(import.meta.url);

export function hasNodeSqlite(): boolean {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

export const describeWithNodeSqlite: typeof describe = hasNodeSqlite()
  ? describe
  : (describe.skip as typeof describe);
