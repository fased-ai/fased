import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  validateWenMiningRecoveryRequest,
  type WenMiningRecoveryResult,
} from "./wen-mining-recovery-contract.js";
import { createWenMiningRecoveryLifecycle } from "./wen-mining-recovery-lifecycle.js";
import { recoverWenMiningWithSigner } from "./wen-mining-recovery.js";

it
  .skipIf(!process.env.WEN_RECOVERY_SOCKET_BINARY)
  .each(["empty", "malformed", "lifecycle-empty", "lifecycle-malformed"])(
  "real Go recovery socket: %s",
  async (mode) => {
    const binary = process.env.WEN_RECOVERY_SOCKET_BINARY;
    if (!binary) {
      throw Error("Build and supply WEN_RECOVERY_SOCKET_BINARY for this integration test");
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "wen-rec-"));
    const child = spawn(binary, ["-test.run=^TestWENMiningRecoverySocketHost$"], {
      cwd: fileURLToPath(new URL("../../tools/fased-signerd/", import.meta.url)),
      env: {
        ...process.env,
        WEN_RECOVERY_SOCKET_DIR: dir,
        WEN_RECOVERY_SOCKET_MODE: mode.replace("lifecycle-", ""),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output = (output + String(data)).slice(-8192);
    });
    child.stderr.on("data", (data) => {
      output = (output + String(data)).slice(-8192);
    });
    let stopped = false;
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        stopped = true;
        resolve(code);
      });
    });
    void done.catch(() => {
      stopped = true;
    });
    const lifecycle = createWenMiningRecoveryLifecycle();
    try {
      let ready: { socket: string; walletId: string; request: unknown } | undefined;
      const until = Date.now() + 45000;
      while (Date.now() < until && !stopped) {
        try {
          ready = JSON.parse(await readFile(path.join(dir, "ready.json"), "utf8"));
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!ready) {
        throw Error(`Host unavailable: ${output}`);
      }
      let result: Promise<WenMiningRecoveryResult>;
      let delivered = 0;
      if (mode.startsWith("lifecycle-")) {
        let accept!: (value: WenMiningRecoveryResult) => void;
        let reject!: (error: unknown) => void;
        result = new Promise((resolve, fail) => {
          accept = resolve;
          reject = fail;
        });
        // Observe rejection immediately; the assertion below owns its outcome.
        void result.catch(() => {});
        const request = validateWenMiningRecoveryRequest(ready.request);
        await lifecycle.start({
          socketPath: ready.socket,
          walletId: ready.walletId,
          ticks: 10,
          intervalMs: 5000,
          request: async (signal) => {
            signal.throwIfAborted();
            return request;
          },
          onResult: (value) => {
            delivered++;
            accept(value);
          },
          onError: reject,
        });
      } else {
        result = recoverWenMiningWithSigner(ready.socket, ready.walletId, ready.request);
      }
      if (mode.endsWith("empty")) {
        expect(await result).toEqual({
          items: [],
          nextCursor: "",
          scanComplete: true,
          scanned: 0,
          signingEnabled: false,
        });
      } else {
        await expect(result).rejects.toThrow(/admission|review/i);
      }
      await lifecycle.stop();
      if (mode.startsWith("lifecycle-")) {
        expect(delivered).toBe(mode.endsWith("empty") ? 1 : 0);
      }
      expect(await done, output).toBe(0);
    } finally {
      await lifecycle.stop();
      if (!stopped) {
        child.kill();
        await done.catch(() => {});
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
  60000,
);
