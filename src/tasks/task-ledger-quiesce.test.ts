import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acknowledgeTaskLedgerQuiesceRequest,
  ensureTaskLedgerQuiesceCapability,
  TASK_LEDGER_QUIESCE_ACK_FILE,
  TASK_LEDGER_QUIESCE_CAPABILITY_FILE,
  TASK_LEDGER_QUIESCE_REQUEST_FILE,
} from "./task-ledger-quiesce.js";

let root: string;
let previousStateDir: string | undefined;

function tasksDirectory(): string {
  return path.join(root, "tasks");
}

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  root = await mkdtemp(path.join(os.tmpdir(), "fased-task-ledger-quiesce-"));
  process.env.FASED_STATE_DIR = root;
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousStateDir;
  }
  await rm(root, { recursive: true, force: true });
});

describe("task ledger quiesce protocol", () => {
  it("writes a persistent capability and atomically echoes an exact request", async () => {
    ensureTaskLedgerQuiesceCapability();
    const directory = tasksDirectory();
    const markerPath = path.join(directory, TASK_LEDGER_QUIESCE_CAPABILITY_FILE);
    expect(fs.readFileSync(markerPath, "utf8")).toBe(
      '{"schema":1,"capability":"task-ledger-quiesce-v1"}\n',
    );
    const request =
      '{"schema":1,"transactionId":"transaction-1","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n';
    await writeFile(path.join(directory, TASK_LEDGER_QUIESCE_REQUEST_FILE), request, {
      mode: 0o600,
    });

    expect(acknowledgeTaskLedgerQuiesceRequest()).toBe(true);
    expect(fs.readFileSync(path.join(directory, TASK_LEDGER_QUIESCE_ACK_FILE), "utf8")).toBe(
      request,
    );
  });

  it("does not acknowledge absent requests and rejects unsafe or noncanonical requests", async () => {
    ensureTaskLedgerQuiesceCapability();
    expect(acknowledgeTaskLedgerQuiesceRequest()).toBe(false);
    const requestPath = path.join(tasksDirectory(), TASK_LEDGER_QUIESCE_REQUEST_FILE);
    const outside = path.join(root, "outside");
    await writeFile(outside, "request\n");
    fs.symlinkSync(outside, requestPath);
    expect(() => acknowledgeTaskLedgerQuiesceRequest()).toThrow("unsafe");
  });

  it("never replaces an acknowledgement that appeared before publication", async () => {
    ensureTaskLedgerQuiesceCapability();
    const directory = tasksDirectory();
    const request =
      '{"schema":1,"transactionId":"transaction-1","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n';
    const ackPath = path.join(directory, TASK_LEDGER_QUIESCE_ACK_FILE);
    await writeFile(path.join(directory, TASK_LEDGER_QUIESCE_REQUEST_FILE), request, {
      mode: 0o600,
    });
    await writeFile(ackPath, "pre-existing\n", { mode: 0o600 });

    expect(() => acknowledgeTaskLedgerQuiesceRequest()).toThrow("collision");
    expect(fs.readFileSync(ackPath, "utf8")).toBe("pre-existing\n");
  });
});
