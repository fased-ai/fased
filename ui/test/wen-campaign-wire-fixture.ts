import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { registerWenApprovalGateway } from "../../extensions/sat-mining/src/wen-approval-gateway.js";
import type { FasedAgentPluginApi } from "../../src/plugins/types.js";
import { createWenCampaignGatewayProfile } from "../../src/wallet/wen-campaign-gateway-profile.js";

const goModuleCache =
  process.env.GOMODCACHE || execFileSync("go", ["env", "GOMODCACHE"], { encoding: "utf8" }).trim();
const goBuildCache =
  process.env.GOCACHE || execFileSync("go", ["env", "GOCACHE"], { encoding: "utf8" }).trim();

// Test-only HTTP adapter around actual gateway handlers and actual Unix client.
// The Unix peer is the compiled Go signer test service; only Solana RPC is simulated.
export async function startCampaignWireFixture(
  origin: string,
  operation:
    | "stop"
    | "setup"
    | "policy"
    | "claim"
    | "claim-stake"
    | "buy"
    | "bond-claim"
    | "bond-purchase" = "stop",
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wen-browser-signer-"));
  const socketPath = path.join(dir, "signer.sock");
  const root = new URL("../../", import.meta.url).pathname;
  const child = spawn("go", ["test", ".", "-run", "^TestWENCampaignBrowserSigner$", "-count=1"], {
    cwd: path.join(root, "tools/fased-signerd"),
    env: {
      ...process.env,
      GOCACHE: goBuildCache,
      GOMODCACHE: goModuleCache,
      WEN_BROWSER_TEST_DIR: dir,
      WEN_BROWSER_TEST_ORIGIN: origin,
      WEN_BROWSER_TEST_OPERATION: operation,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (v) => {
    log = (log + v.toString()).slice(-65536);
  });
  child.stderr.on("data", (v) => {
    log = (log + v.toString()).slice(-65536);
  });
  const finished = new Promise<number | null>((resolve) => {
    child.on("exit", resolve);
    child.on("error", () => resolve(-1));
  });
  async function shutdownSigner() {
    await writeFile(path.join(dir, "stop"), "");
    const timer = setTimeout(() => child.kill("SIGTERM"), 5000);
    const code = await finished;
    clearTimeout(timer);
    await writeFile(path.join(dir, "signer-subprocess.log"), log);
    return code;
  }
  let review;
  try {
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      try {
        review = JSON.parse(await readFile(path.join(dir, "ready.json"), "utf8"));
        break;
      } catch {}
      if (child.exitCode !== null) {
        throw Error(log);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!review) {
      throw Error("Signer test startup timed out: " + log);
    }
  } catch (error) {
    await shutdownSigner();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const a = review.semanticIntent;
  const expected =
    operation === "bond-purchase"
      ? {
          requestId: review.requestId,
          walletId: review.walletId,
          walletPublicKey: review.walletPublicKey,
          policyHash: review.policyHash,
          artifactDigest: review.artifactDigest,
          pins: a.Pins,
          policy: a.Policy,
          limits: a.Limits,
        }
      : operation === "bond-claim"
        ? {
            requestId: review.requestId,
            walletId: review.walletId,
            walletPublicKey: review.walletPublicKey,
            policyHash: review.policyHash,
            artifactDigest: review.artifactDigest,
            pins: a.Pins,
            policy: a.Policy,
            maxFee: a.MaxFee,
            retainedLamports: a.RetainedLamports,
          }
        : operation === "buy"
          ? {
              requestId: review.requestId,
              walletId: review.walletId,
              walletPublicKey: review.walletPublicKey,
              policyHash: review.policyHash,
              pins: a.Pins,
              policy: a.Policy,
              limits: a.Limits,
              maxFee: BigInt(a.Binding.MaxFee),
              retainedLamports: BigInt(a.Binding.RetainedLamports),
            }
          : operation === "claim-stake"
            ? {
                requestId: review.requestId,
                walletId: review.walletId,
                walletPublicKey: review.walletPublicKey,
                policyHash: review.policyHash,
                program: a.Claim.Program,
                economy: a.Claim.Economy,
                position: a.Snapshot.Claim.Position.Address,
                operation,
                amount: 0n,
                claimStake: {
                  destination: a.Claim.Destination,
                  pool: a.Snapshot.History.Pool.Address,
                  stakingPosition: a.Snapshot.History.Position.Address,
                  mint: a.Intent.mint,
                  pageIndex: BigInt(a.Claim.PageIndex),
                  mask: BigInt(a.Claim.Mask),
                  minimumNet: BigInt(a.MinimumNet),
                  maxTotal: BigInt(a.MaxTotal),
                  descriptorSha256: a.Pins.DescriptorSHA256,
                  capabilitySha256: a.Pins.CapabilitySHA256,
                  day: BigInt(a.Intent.day),
                  last: BigInt(a.Intent.last),
                  aggregateFrom: BigInt(a.Intent.aggregateFrom),
                },
                maxFee: BigInt(a.Intent.maxFeeLamports),
                genesis: a.Pins.Genesis,
                codeSha256: a.Pins.CodeSHA256,
                deploymentSlot: BigInt(a.Pins.DeploymentSlot),
                upgradeAuthority: a.Pins.UpgradeAuthority,
              }
            : {
                requestId: review.requestId,
                walletId: review.walletId,
                walletPublicKey: review.walletPublicKey,
                policyHash: review.policyHash,
                program: a.Action.Program,
                economy: a.Action.Economy,
                position: a.Action.Position,
                operation: a.Action.Operation,
                amount: BigInt(a.Action.Amount),
                ...(a.Action.Claim
                  ? {
                      claim: {
                        destination: a.Action.Claim.Destination,
                        pageIndex: BigInt(a.Action.Claim.PageIndex),
                        mask: BigInt(a.Action.Claim.Mask),
                        minNet: 970n,
                      },
                    }
                  : {}),
                ...(a.Action.Policy
                  ? {
                      policy: {
                        window: a.Action.Policy.Window,
                        maxPrice: BigInt(a.Action.Policy.MaxPrice),
                        daily: BigInt(a.Action.Policy.Daily),
                        total: BigInt(a.Action.Policy.Total),
                        expiry: BigInt(a.Action.Policy.Expiry),
                        maxWait: BigInt(a.Action.Policy.MaxWait),
                        enabled: BigInt(a.Action.Policy.Enabled),
                      },
                    }
                  : {}),
                ...(a.Action.Setup
                  ? {
                      setup: {
                        issuer: a.Action.Setup.Issuer,
                        nonce: BigInt(a.Action.Setup.Nonce),
                        deposit: BigInt(a.Action.Setup.Terms.Deposit),
                        maxPrice: BigInt(a.Action.Setup.Terms.MaxPrice),
                        daily: BigInt(a.Action.Setup.Terms.Daily),
                        total: BigInt(a.Action.Setup.Terms.Total),
                        expiry: BigInt(a.Action.Setup.Terms.Expiry),
                        maxWait: BigInt(a.Action.Setup.Terms.MaxWait),
                        maxRent: BigInt(a.Binding.Setup.Rent),
                      },
                    }
                  : {}),
                maxFee: BigInt(a.Binding.MaxFee),
                genesis: a.Pins.Genesis,
                codeSha256: a.Pins.CodeSHA256,
                deploymentSlot: BigInt(a.Pins.DeploymentSlot),
                upgradeAuthority: a.Pins.UpgradeAuthority,
              };
  const events: string[] = [];
  async function enroll(op: string, request: unknown) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let text = "";
      socket.setTimeout(10000, () => socket.destroy(Error("enrollment timeout")));
      socket.on("error", reject);
      socket.on("connect", () => socket.write(JSON.stringify({ op, request }) + "\n"));
      socket.on("data", (v) => {
        text += v.toString();
        if (text.includes("\n")) {
          socket.end();
          try {
            const value = JSON.parse(text.split("\n")[0]);
            if (!value.ok) {
              throw Error(value.error);
            }
            resolve(value.result);
          } catch (e) {
            reject(e);
          }
        }
      });
    });
  }
  const profile = createWenCampaignGatewayProfile(
    async () => ({
      socket: { walletId: review.walletId, socketPath, revision: "fixture-1" },
      expected,
      draftSha256:
        operation === "buy" || operation === "bond-claim" || operation === "bond-purchase"
          ? await readFile(path.join(dir, "draft-sha256"), "utf8")
          : "a".repeat(64),
      artifactDigest: review.artifactDigest.slice(7),
    }),
    operation === "bond-purchase"
      ? "bond"
      : operation === "bond-claim"
        ? "bond-claim"
        : operation === "buy"
          ? "market"
          : "campaign",
  );
  const handlers = new Map<string, Parameters<FasedAgentPluginApi["registerGatewayMethod"]>[1]>();
  const cancel = registerWenApprovalGateway(
    {
      registerGatewayMethod(name, handler) {
        handlers.set(name, handler);
      },
    },
    () => profile,
    operation === "bond-purchase"
      ? "wen.bond.approval"
      : operation === "bond-claim"
        ? "wen.bond-claim.approval"
        : operation === "buy"
          ? "wen.market.approval"
          : "wen.campaign.approval",
  );
  const token = randomUUID();
  let busy = false;
  let lostRecovery = false;
  const gateway = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.url !== "/" + token || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    if (busy) {
      res.writeHead(409).end();
      return;
    }
    busy = true;
    const now = Date.now;
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 65536) {
          throw Error("too large");
        }
      }
      const { method, params } = JSON.parse(body);
      if (method === "test.registration.begin" || method === "test.registration.finish") {
        const result = await enroll(method.replace("test.", "v2.webauthn."), params);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
        return;
      }
      const handler = handlers.get(method);
      if (!handler) {
        throw Error("unknown method");
      }
      // Existing signed-review fixture uses a fixed time. No production clock changes.
      Date.now = () => Date.parse(review.issuedAt) + 1;
      await handler({
        params,
        client: { connId: "fixture-browser" },
        respond(ok: boolean, value: unknown) {
          if (
            (operation === "bond-claim" || operation === "bond-purchase") &&
            method.endsWith(".recover") &&
            !lostRecovery
          ) {
            lostRecovery = true;
            res.writeHead(500).end();
            return;
          }
          res
            .writeHead(ok ? 200 : 409, { "Content-Type": "application/json" })
            .end(JSON.stringify(value ?? { error: "rejected" }));
        },
      } as never);
    } catch {
      if (!res.writableEnded) {
        res.writeHead(500).end();
      }
    } finally {
      Date.now = now;
      busy = false;
    }
  });
  async function stop() {
    cancel();
    profile.cancelClaimApproval();
    gateway.closeAllConnections();
    await new Promise<void>((r) => gateway.close(() => r()));
    const code = await shutdownSigner();
    try {
      events.push(...JSON.parse(await readFile(path.join(dir, "events.json"), "utf8")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    if (code !== 0) {
      throw Error("Compiled signer test failed: " + log);
    }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      gateway.once("error", reject);
      gateway.listen(0, "127.0.0.1", resolve);
    });
    const address = gateway.address() as net.AddressInfo;
    return { url: `http://127.0.0.1:${address.port}/${token}`, events, stop, profile };
  } catch (error) {
    await stop();
    throw error;
  }
}
