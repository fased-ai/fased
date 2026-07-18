import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listWalletSettlementLinks,
  upsertWalletSettlementLink,
} from "./wallet-settlement-links.js";

const tempDirectories: string[] = [];

function createEnv(): { env: NodeJS.ProcessEnv; filePath: string } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-wallet-settlement-"));
  tempDirectories.push(stateDir);
  const walletDir = path.join(stateDir, "wallet");
  fs.mkdirSync(walletDir, { recursive: true });
  return {
    env: { FASED_STATE_DIR: stateDir },
    filePath: path.join(walletDir, "wallet-settlement-links.json"),
  };
}

describe("wallet settlement links", () => {
  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists valid request linkage atomically", () => {
    const { env } = createEnv();
    upsertWalletSettlementLink({ requestId: "req-1", taskId: "task-1", env });
    expect(listWalletSettlementLinks({ env })).toMatchObject([
      { requestId: "req-1", taskId: "task-1", status: "pending" },
    ]);
  });

  it("fails closed without replacing corrupt request linkage", () => {
    const { env, filePath } = createEnv();
    fs.writeFileSync(filePath, "{not-json\n", "utf8");

    expect(() => listWalletSettlementLinks({ env })).toThrow("refusing to reset request links");
    expect(fs.readFileSync(filePath, "utf8")).toBe("{not-json\n");
  });
});
