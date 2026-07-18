import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeWalletStateFileAtomically } from "./wallet-atomic-state.js";

const tempDirectories: string[] = [];

describe("wallet atomic state", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirectories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it("durably replaces a wallet state file with owner-only permissions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-atomic-"));
    tempDirectories.push(directory);
    const filePath = path.join(directory, "state.json");

    writeWalletStateFileAtomically(filePath, '{"version":1}\n');

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe('{"version":1}\n');
    if (process.platform !== "win32") {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves the previous file and cleans temporary state when rename is interrupted", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-atomic-"));
    tempDirectories.push(directory);
    const filePath = path.join(directory, "state.json");
    await fs.writeFile(filePath, '{"version":1,"value":"old"}\n', { mode: 0o600 });
    vi.spyOn(fsSync, "renameSync").mockImplementationOnce(() => {
      throw new Error("simulated interrupted rename");
    });

    expect(() => writeWalletStateFileAtomically(filePath, '{"version":1,"value":"new"}\n')).toThrow(
      "simulated interrupted rename",
    );
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe('{"version":1,"value":"old"}\n');
    expect((await fs.readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
