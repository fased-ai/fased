import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { inspectWenBtcWithSigner } from "./wen-btc-inspection.js";
import { prepareWenBtcWithSigner } from "./wen-btc-preparation.js";

it.each([
  {
    operation: "acquisition",
    mutation: "route-stale",
    error: "reviewed route stale or expired",
    prepare: true,
  },
  {
    operation: "acquisition",
    mutation: "route-expires-during",
    error: "reviewed route stale or expired",
    prepare: true,
  },
  {
    operation: "acceptance",
    mutation: "simulation-error",
    error: "simulation or cost admission rejected",
    prepare: true,
  },
  {
    operation: "acquisition",
    mutation: "simulation-error",
    error: "simulation or cost admission rejected",
    prepare: true,
  },
  { operation: "acceptance", mutation: "", error: "", prepare: true },
  { operation: "acquisition", mutation: "", error: "", prepare: true },
  { operation: "acceptance", mutation: "", error: "" },
  { operation: "acquisition", mutation: "", error: "" },
  { operation: "acquisition", mutation: "consumed", error: "funded acquisition readback mismatch" },
  { operation: "acquisition", mutation: "underfunded", error: "funding custody mismatch" },
  { operation: "acquisition", mutation: "route-tampered", error: "artifact digest mismatch" },
])(
  "joined Go service: $operation / $mutation",
  async ({ operation, mutation, error, prepare }) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wen-joined-"));
    const cwd = fileURLToPath(new URL("../../tools/fased-signerd/", import.meta.url));
    const child = spawn("go", ["test", ".", "-run", "^TestWENBTCJoinedClientHost$", "-count=1"], {
      cwd,
      env: {
        ...process.env,
        GOCACHE: process.env.GOCACHE ?? "/tmp/fased-go-build-cache",
        WEN_JOINED_CLIENT_TEST_DIR: dir,
        WEN_JOINED_CLIENT_OPERATION: operation,
        WEN_JOINED_CLIENT_MUTATION: mutation,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output = (output + data.toString()).slice(-8192);
    });
    child.stderr.on("data", (data: Buffer) => {
      output = (output + data.toString()).slice(-8192);
    });
    let stopped = false;
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        stopped = true;
        resolve(code);
      });
    });
    // Attach immediately so a spawn failure cannot become an unhandled rejection.
    void done.catch(() => {
      stopped = true;
    });
    try {
      let ready: { socket: string; walletId: string; intent: unknown } | undefined;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !stopped) {
        try {
          ready = JSON.parse(await readFile(path.join(dir, "ready.json"), "utf8"));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!ready) {
        throw new Error(`Go test host did not become ready: ${output}`);
      }
      expect(ready.socket).toBe(path.join(dir, "signer.sock"));
      if (error) {
        await expect(
          (prepare ? prepareWenBtcWithSigner : inspectWenBtcWithSigner)(
            ready.socket,
            ready.walletId,
            ready.intent,
          ),
        ).rejects.toThrow(error);
      } else if (prepare) {
        const result = await prepareWenBtcWithSigner(ready.socket, ready.walletId, ready.intent);
        expect(result.status).toBe("requires-signing-revalidation");
        expect(result.signingEnabled).toBe(false);
        expect(result.operation).toBe(operation);
        expect(result.minimumSlot).toBe("150");
        expect(result.simulationSlot).toBe("155");
        expect(result.networkFeeLamports).toBe("5000");
        expect(result.computeUnits).toBe("100000");
        expect(BigInt(result.currentHeight)).toBeLessThan(BigInt(result.lastValidHeight));
      } else {
        const result = await inspectWenBtcWithSigner(ready.socket, ready.walletId, ready.intent);
        expect(result.status).toBe("requires-transaction-verification");
        expect(result.signingEnabled).toBe(false);
        expect(result.operation).toBe(operation);
        expect(result.readback.slot).toBe("150");
        expect(Buffer.from(result.readback.dataBase64, "base64")[0]).toBe(
          operation === "acquisition" ? 112 : 111,
        );
      }
      expect(await done, output).toBe(0);
    } finally {
      if (!stopped) {
        child.kill("SIGTERM");
      }
      await done.catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  },
  45000,
);
