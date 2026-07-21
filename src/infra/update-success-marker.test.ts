import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recordUpdateSuccess, updateCompletedRecently } from "./update-success-marker.js";

describe("update success marker", () => {
  it("suppresses a duplicate Doctor update offer only for a recent successful update", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-update-success-"));
    const env = { ...process.env, FASED_STATE_DIR: root };
    try {
      expect(updateCompletedRecently(env)).toBe(false);
      await recordUpdateSuccess({ mode: "git", version: "1.2.3" }, env);
      expect(updateCompletedRecently(env)).toBe(true);
      expect(updateCompletedRecently(env, Date.now() + 11 * 60_000)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
