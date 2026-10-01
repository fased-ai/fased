import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { saveJsonFileAtomic } from "./json-file.js";
it("preserves the prior credential record on failed replacement and removes the temporary", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fased-atomic-test-"));
  const filename = path.join(directory, "auth.json");
  try {
    saveJsonFileAtomic(filename, { access: "previous-test-token" });
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("simulated interrupted write");
    });
    expect(() => saveJsonFileAtomic(filename, { access: "new-test-token" })).toThrow("interrupted");
    rename.mockRestore();
    expect(JSON.parse(fs.readFileSync(filename, "utf8"))).toEqual({
      access: "previous-test-token",
    });
    expect(fs.readdirSync(directory)).toEqual(["auth.json"]);
    saveJsonFileAtomic(filename, { access: "new-test-token", refresh: "rotated-test-token" });
    expect(JSON.parse(fs.readFileSync(filename, "utf8"))).toEqual({
      access: "new-test-token",
      refresh: "rotated-test-token",
    });
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true });
  }
});
