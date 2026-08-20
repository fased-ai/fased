import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetTaskDefinitionLedgerForTests } from "../tasks/task-definition-ledger.js";
import { loadCronStore, resolveCronStorePath, saveCronStore } from "./store.js";

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-cron-store-"));
  return {
    dir,
    storePath: path.join(dir, "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("resolveCronStorePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses FASED_HOME for tilde expansion", () => {
    vi.stubEnv("FASED_HOME", "/srv/fased-home");
    vi.stubEnv("HOME", "/home/other");

    const result = resolveCronStorePath("~/cron/jobs.json");
    expect(result).toBe(path.resolve("/srv/fased-home", "cron", "jobs.json"));
  });
});

describe("cron store", () => {
  afterEach(() => {
    resetTaskDefinitionLedgerForTests();
  });

  it("returns empty store when file does not exist", async () => {
    const store = await makeStorePath();
    const loaded = await loadCronStore(store.storePath);
    expect(loaded).toEqual({ version: 1, jobs: [] });
    await store.cleanup();
  });

  it("throws when store contains invalid JSON", async () => {
    const store = await makeStorePath();
    await fs.writeFile(store.storePath, "{ not json", "utf-8");
    await expect(loadCronStore(store.storePath)).rejects.toThrow(/Failed to parse cron store/i);
    await store.cleanup();
  });

  it("imports legacy JSON once and keeps all operational writes in the task ledger", async () => {
    const store = await makeStorePath();
    const legacy = `${JSON.stringify({
      version: 1,
      jobs: [{ id: "legacy", createdAtMs: 1, updatedAtMs: 1 }],
    })}\n`;
    await fs.writeFile(store.storePath, legacy, "utf8");

    expect((await loadCronStore(store.storePath)).jobs.map((job) => job.id)).toEqual(["legacy"]);
    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [{ id: "ledger", createdAtMs: 2, updatedAtMs: 2 } as never],
    });
    await fs.writeFile(store.storePath, "{ now invalid legacy bytes", "utf8");
    expect((await loadCronStore(store.storePath)).jobs.map((job) => job.id)).toEqual(["ledger"]);
    expect(await fs.readFile(store.storePath, "utf8")).toBe("{ now invalid legacy bytes");
    await expect(fs.stat(`${store.storePath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(store.dir, "tasks", "task-ledger.sqlite")),
    ).resolves.toBeDefined();
    await store.cleanup();
  });
});
