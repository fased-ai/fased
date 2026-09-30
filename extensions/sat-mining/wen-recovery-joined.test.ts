import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { vi } from "vitest";
import { handleGatewayRequest } from "../../src/gateway/server-methods.js";
import { proposeWenMiningClaimWithSigner } from "../../src/wallet/wen-mining-claim-proposal.js";
import plugin from "./index.js";

it
  .skipIf(!process.env.WEN_RECOVERY_SOCKET_BINARY)
  .each([
    "empty",
    "malformed",
    "funded-sol",
    "funded-sol-admit",
    "funded-sat-admit",
    "funded-sol-consumer",
    "funded-sol-restart",
    "funded-sol-pages",
    "funded-sat",
    "funded-sol-replace",
    "funded-sat-replace",
  ])(
  "profile/plugin to Go recovery socket: %s",
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
    let service:
      | {
          start(context: unknown): Promise<void>;
          stop(context: unknown): Promise<void>;
          checkpointForLifecycle(context: unknown): Promise<void>;
        }
      | undefined;
    let refresh!: (context: {
      params: Record<string, unknown>;
      respond: (...args: unknown[]) => void;
    }) => Promise<void>;
    const warnings: string[] = [];
    const context = { stateDir: dir };
    try {
      let ready:
        | { socket: string; walletId: string; request: { pins: unknown; descriptor: string } }
        | undefined;
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
      const profilePath = path.join(dir, "profile.json");
      await writeFile(
        profilePath,
        JSON.stringify({
          version: 1,
          mode: "local-candidate-only",
          walletId: ready.walletId,
          socketPath: ready.socket,
          request: ready.request,
          ticks: 10,
          intervalMs: 5000,
        }),
        { mode: 0o600 },
      );
      vi.stubEnv("FASED_WEN_LOCAL_RECOVERY_PROFILE", profilePath);
      plugin.register({
        pluginConfig: undefined,
        registerGatewayMethod(name: string, handler: typeof refresh) {
          if (name === "wen.mining.review.refresh") refresh = handler;
        },
        registerService(value: NonNullable<typeof service>) {
          service = value;
        },
        logger: {
          info() {},
          warn(message: string) {
            warnings.push(message);
          },
        },
      } as never);
      if (!service) {
        throw Error("plugin did not register");
      }
      await service.start(context);
      if (mode.endsWith("replace")) {
        const deadline = Date.now() + 5000;
        while (true) {
          try {
            await stat(path.join(dir, "reading"));
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() > deadline)
              throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const changed = JSON.parse(await readFile(profilePath, "utf8"));
        changed.walletId = "replacement";
        await writeFile(profilePath, JSON.stringify(changed));
        await writeFile(path.join(dir, "resume"), "ready");
      }
      let mailbox: unknown;
      const deliveryDeadline = Date.now() + 10000;
      while (Date.now() < deliveryDeadline) {
        try {
          mailbox = JSON.parse(await readFile(profilePath + ".review.json", "utf8"));
          if (mode.endsWith("pages") && (mailbox as { history: unknown[] }).history.length < 2) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            continue;
          }
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        if (warnings.length) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (mode.endsWith("consumer")) {
        await writeFile(profilePath + ".review.json", '{"signingEnabled":true,"result":"forged"}');
        const respond = vi.fn();
        const method = "wen.mining.review.refresh";
        const routed = vi.fn(refresh);
        const invoke = async (scopes: string[], role = "operator") =>
          handleGatewayRequest({
            req: { type: "req", id: "wen-review-test", method, params: {} },
            client: { connId: "wen-review-test", connect: { role, scopes } } as Parameters<
              typeof handleGatewayRequest
            >[0]["client"],
            respond,
            isWebchatConnect: () => false,
            context: {} as Parameters<typeof handleGatewayRequest>[0]["context"],
            extraHandlers: { [method]: routed },
          });
        for (const scopes of [[], ["operator.read"], ["operator.write"]]) {
          await invoke(scopes);
          expect(respond.mock.calls.at(-1)?.[0]).toBe(false);
          expect(routed).not.toHaveBeenCalled();
        }
        await invoke(["operator.admin"], "node");
        expect(respond.mock.calls.at(-1)?.[0]).toBe(false);
        expect(routed).not.toHaveBeenCalled();
        respond.mockClear();
        await invoke(["operator.admin"]);
        expect(routed).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0][0]).toBe(true);
        const fresh = respond.mock.calls[0][1].payload;
        expect(fresh).toEqual((mailbox as { result: unknown }).result);
        expect(fresh.items).toHaveLength(1);
        expect(fresh.signingEnabled).toBe(false);
      }
      if (mode.endsWith("restart")) {
        expect(mailbox).toMatchObject({ result: { scanned: 1 } });
        await service.stop(context);
        const changed = JSON.parse(await readFile(profilePath, "utf8"));
        changed.request.minFinalizedSlot = "101";
        changed.request.expiresSlot = "133";
        await writeFile(profilePath, JSON.stringify(changed));
        await service.start(context);
        const deadline = Date.now() + 10000;
        while (true) {
          const current = JSON.parse(await readFile(profilePath + ".review.json", "utf8"));
          if (current.history[0].request.minFinalizedSlot === "101") {
            expect(current.history).toHaveLength(1);
            expect(current.history[0].request.cursor).toBe("");
            mailbox = current;
            break;
          }
          if (Date.now() > deadline) throw Error("restart result missing: " + warnings.join(" "));
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      if (mode.endsWith("admit")) {
        const item = (mailbox as { result: { items: { reviewDraft: unknown }[] } }).result.items[0];
        await writeFile(path.join(dir, "exported.json"), JSON.stringify(item.reviewDraft), {
          mode: 0o600,
        });
        await service.stop(context);
        let admitted;
        const deadline = Date.now() + 10000;
        while (!admitted) {
          try {
            admitted = JSON.parse(await readFile(path.join(dir, "admitted.json"), "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() > deadline)
              throw error;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        expect(admitted).toMatchObject({
          status: "review-installed",
          walletId: "miner",
          signingEnabled: false,
        });
        const draft = item.reviewDraft as { review: { intent: Record<string, unknown> } };
        const request = {
          base: draft.review.intent,
          reviewSha256: admitted.reviewSha256,
          minFinalizedSlot: "101",
          expiresSlot: "133",
        };
        const proposal = await proposeWenMiningClaimWithSigner(
          ready.socket,
          ready.walletId,
          request,
        );
        expect(proposal).toMatchObject({
          signingEnabled: false,
          baseReviewSha256: admitted.reviewSha256,
          intent: {
            ...draft.review.intent,
            accountStateSha256: expect.any(String),
            minFinalizedSlot: "101",
            expiresSlot: "133",
          },
        });
        for (const [wallet, changed] of [
          [ready.walletId, { ...request, reviewSha256: "f".repeat(64) }],
          ["other", request],
          [ready.walletId, { ...request, base: { ...request.base, id: "999" } }],
        ] as const) {
          await expect(
            proposeWenMiningClaimWithSigner(ready.socket, wallet, changed),
          ).rejects.toThrow();
        }
        expect(await done, output).toBe(0);
      }
      await service.checkpointForLifecycle(context);
      await service.stop(context);
      if (mode.endsWith("pages")) {
        expect(warnings, output).toEqual([]);
        const history = (
          mailbox as {
            history: {
              request: { cursor: string };
              result: { items: unknown[]; nextCursor: string; scanComplete: boolean };
            }[];
          }
        ).history;
        expect(history).toHaveLength(2);
        expect(history[0].result.items).toHaveLength(1);
        expect(history[0].result.scanComplete).toBe(false);
        expect(history[1].request.cursor).toBe(history[0].result.nextCursor);
        expect(history[1].result.items).toEqual([]);
        expect(history[1].result.scanComplete).toBe(true);
      } else if (mode === "empty") {
        expect(warnings).toEqual([]);
        expect(mailbox).toEqual({
          version: 1,
          mode: "local-candidate-only",
          walletId: ready.walletId,
          signingEnabled: false,
          history: expect.any(Array),
          historyMeaning: "observations-only-revalidate-before-review",
          result: {
            items: [],
            nextCursor: "",
            scanComplete: true,
            scanned: 0,
            signingEnabled: false,
          },
        });
        expect((await stat(profilePath + ".review.json")).mode & 0o777).toBe(0o600);
      } else if (
        mode === "funded-sol" ||
        mode === "funded-sat" ||
        mode.endsWith("restart") ||
        mode.endsWith("consumer") ||
        mode.endsWith("admit")
      ) {
        expect(warnings, output).toEqual([]);
        expect(mailbox).toMatchObject({
          walletId: ready.walletId,
          signingEnabled: false,
          result: {
            scanned: 1,
            scanComplete: true,
            nextCursor: "",
            signingEnabled: false,
            items: [
              {
                status: "requires-review",
                proposal: { status: "requires-review", signingEnabled: false },
                reviewDraft: {
                  descriptor: ready.request.descriptor,
                  review: {
                    walletId: ready.walletId,
                    pins: ready.request.pins,
                    maxTotalCostLamports: 5000,
                    maxSlotLag: 2,
                    intent: {
                      operation: mode.startsWith("funded-sat") ? "sat" : "sol",
                      expectedGross: mode.startsWith("funded-sat") ? "20" : "100",
                      minimumReceived: mode.startsWith("funded-sat") ? "19" : "100",
                      minFinalizedSlot: "101",
                      expiresSlot: mode.endsWith("restart") ? "133" : "132",
                      maxFeeLamports: "5000",
                    },
                  },
                },
              },
            ],
          },
        });
        expect((await stat(profilePath + ".review.json")).mode & 0o777).toBe(0o600);
      } else {
        expect(mailbox).toBeUndefined();
        expect(warnings.join(" ")).toMatch(
          mode.endsWith("replace") ? /profile changed during recovery/ : /admission|review/i,
        );
      }
      expect(await done, output).toBe(0);
    } finally {
      await service?.stop(context);
      vi.unstubAllEnvs();
      if (!stopped) {
        child.kill();
        await done.catch(() => {});
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
  60000,
);
