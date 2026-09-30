import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { prepareWenMiningReviewWithSigner } from "./wen-mining-review-preparation.js";
it.skipIf(!process.env.WEN_PREPARE_SOCKET_BINARY).each(["sol", "sat"])(
  "actual daemon preparation: %s",
  async (op) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wen-prep-"));
    const child = spawn(
      process.env.WEN_PREPARE_SOCKET_BINARY!,
      ["-test.run=^TestWENMiningClaimPrepareSocketHost$", "-test.v"],
      {
        cwd: fileURLToPath(new URL("../../tools/fased-signerd/", import.meta.url)),
        env: { ...process.env, WEN_PREPARE_SOCKET_DIR: dir, WEN_PREPARE_SOCKET_OPERATION: op },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      stopped = false;
    child.stdout.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-12000);
    });
    child.stderr.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-12000);
    });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        stopped = true;
        resolve(code);
      });
    });
    void done.catch(() => {});
    try {
      let ready;
      const deadline = Date.now() + 30000;
      while (!ready && Date.now() < deadline && !stopped) {
        try {
          ready = JSON.parse(await readFile(path.join(dir, "ready.json"), "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        if (!ready) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      if (!ready) {
        throw Error("Preparation host unavailable: " + output);
      }
      const review = await prepareWenMiningReviewWithSigner(
        ready.socket,
        ready.walletId,
        ready.request,
      );
      expect(review.state).toBe("prepared");
      expect(review.semanticIntent.intent.operation).toBe(op);
      expect(review.amount).toBe("5000");
      await expect(
        prepareWenMiningReviewWithSigner(ready.socket, ready.walletId, ready.request),
      ).rejects.toThrow("already exists");
      await expect(
        prepareWenMiningReviewWithSigner(ready.socket, "other", ready.request),
      ).rejects.toThrow();
      expect(await done, output).toBe(0);
    } finally {
      if (!stopped) {
        child.kill("SIGTERM");
      }
      await done.catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  },
  45000,
);
