import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import plugin from "../../extensions/wen/index.js";
import { createServer } from "../../ui/node_modules/vite/dist/node/index.js";
import type { GatewayBrowserClient as BrowserClient } from "../../ui/src/ui/gateway.js";
import type { WenReviewPanel } from "../../ui/src/ui/views/wen-review.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { readWenEconomyLocal } from "../wallet/wen-economy-read.js";
import {
  connectReq,
  testState,
  trackConnectChallengeNonce,
  getFreePort,
  installGatewayTestHooks,
  rpcReq,
  setTestPluginRegistry,
  startGatewayServer,
} from "./test-helpers.js";
const chromiumExecutable = chromium.executablePath();

const profile = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  prepareClaimApproval: vi.fn(async () => ({ requestId: "fixture" })),
  beginClaimApproval: vi.fn(async () => ({ challengeId: "fixture" })),
  finishClaimApproval: vi.fn(async () => ({ proofId: "fixture" })),
  cancelClaimApproval: vi.fn(),
  runClaimJourney: vi.fn(async () => ({ outcome: "finalized-success" })),
  refreshReviewPage: vi.fn(async () => ({ items: [], signingEnabled: false })),
}));
vi.mock("fased/plugin-sdk/wen-runtime", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createLocalWenRecoveryProfile: async () => profile,
}));
installGatewayTestHooks({ scope: "suite" });

test("WEN review requires authenticated admin over WebSocket", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wen-ws-"));
  const registry = createEmptyPluginRegistry();
  let service!: { start(c: unknown): Promise<void>; stop(c: unknown): Promise<void> };
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  const sockets: WebSocket[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let uiServer: Awaited<ReturnType<typeof createServer>> | undefined;
  let readServer: ReturnType<typeof createHttpServer> | undefined;
  try {
    vi.stubEnv("FASED_WEN_LOCAL_RECOVERY_PROFILE", "/local/test-profile.json");
    const readPort = await getFreePort();
    const readPin = {
      economy: "sat-v1",
      genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      program: "a".repeat(64),
      mint: "mint",
      deployedBytesHash: "a".repeat(64),
      deploymentSlot: "12",
      upgradeAuthority: null,
    };
    readServer = createHttpServer((req, res) => {
      if (req.url !== "/api/v1/economies/sat-v1/factsheet") {
        res.writeHead(404).end();
        return;
      }
      const observedAtMs = Date.now();
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          schema: "wen.economy.read.v1",
          mode: "local-devnet-read-only",
          signingEnabled: false,
          identity: {
            economy: readPin.economy,
            genesis: readPin.genesis,
            program: readPin.program,
            mint: readPin.mint,
          },
          deployment: {
            deployedBytesHash: readPin.deployedBytesHash,
            deploymentSlot: readPin.deploymentSlot,
            upgradeAuthority: null,
          },
          slot: "13",
          observedAtMs,
          rows: [
            ...["issuedSupply", "unmintedObligations", "protocolAsset"].map((id) => ({
              id,
              status: "reported",
              value: "10",
              unit: "atoms",
              evidence: "onchain",
              source: "account",
              scope: "Current account",
              observedAtMs,
            })),
            {
              id: "economicNav",
              status: "unavailable",
              value: null,
              reason: "Coverage incomplete",
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      readServer!.once("error", reject);
      readServer!.listen(readPort, "127.0.0.1", resolve);
    });
    const readProfile = path.join(dir, "wen-economy-read.json");
    await writeFile(
      readProfile,
      JSON.stringify({
        url: `http://127.0.0.1:${readPort}/api/v1/economies/sat-v1/factsheet`,
        pin: readPin,
      }),
    );
    vi.stubEnv("FASED_WEN_LOCAL_READ_PROFILE", readProfile);
    plugin.register({
      registerGatewayMethod(
        name: string,
        handler: (typeof registry.gatewayHandlers)[string],
        opts?: { scope: "operator.admin" | "operator.read" },
      ) {
        registry.gatewayHandlers[name] = handler;
        if (opts) {
          registry.gatewayMethodScopes[name] = opts.scope;
        }
      },
      registerService(value: typeof service) {
        service = value;
      },
      registerTool() {},
      logger: { info() {}, warn() {} },
    } as never);
    setTestPluginRegistry(registry);
    uiServer = await createServer({
      configFile: false,
      root: path.resolve("ui"),
      optimizeDeps: { noDiscovery: true, include: ["@solana/web3.js"] },
      server: { host: "127.0.0.1", port: await getFreePort() },
    });
    uiServer.middlewares.use((req, res, next) => {
      if (req.url !== "/wen-review-fixture") {
        next();
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><html><body></body></html>");
    });
    await uiServer.listen();
    await service.start({ stateDir: dir });
    const uiUrl = uiServer.resolvedUrls!.local[0].replace(/\/$/, "");
    await readWenEconomyLocal({
      url: `http://127.0.0.1:${readPort}/api/v1/economies/sat-v1/factsheet`,
      pin: readPin,
    });
    testState.gatewayControlUi = { allowedOrigins: [uiUrl] };
    const port = await getFreePort();
    server = await startGatewayServer(port);
    const open = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      trackConnectChallengeNonce(ws);
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      return ws;
    };
    const wrong = await open();
    expect((await connectReq(wrong, { token: "incorrect-test-token" })).ok).toBe(false);
    expect(profile.refreshReviewPage).not.toHaveBeenCalled();
    const reader = await open();
    expect((await connectReq(reader, { scopes: ["operator.read"] })).ok).toBe(true);
    const denied = await rpcReq(reader, "wen.mining.review.refresh", {});
    expect(denied.ok).toBe(false);
    expect(denied.error?.message).toContain("operator.admin");
    expect(profile.refreshReviewPage).not.toHaveBeenCalled();
    const economy = await rpcReq(reader, "wen.economy.read", {});
    const handoff = await rpcReq(reader, "wen.acquisition.handoff", {
      owner: "C9y1TCfmUh3DbCpec1GvuuWdV4EYcE2N23tsgcUbgJ4N",
      action: "buy",
      netAtoms: "100000000000",
    });
    expect(handoff.ok).toBe(true);
    expect(handoff.payload).toMatchObject({ mode: "manual-owner-handoff", signingEnabled: false });

    expect(economy.ok, JSON.stringify(economy)).toBe(true);
    expect(economy.payload).toMatchObject({ signingEnabled: false });
    expect((economy.payload as { rows: unknown[] }).rows[0]).toMatchObject({
      id: "issuedSupply",
      status: "reported",
    });
    const admin = await open();
    expect((await connectReq(admin, { scopes: ["operator.admin"] })).ok).toBe(true);
    for (const method of ["prepare", "begin", "finish", "cancel", "execute", "recover"]) {
      const deniedApproval = await rpcReq(reader, "wen.mining.approval." + method, {});
      expect(deniedApproval.ok).toBe(false);
      expect(deniedApproval.error?.message).toContain("operator.admin");
    }
    expect((await rpcReq(admin, "wen.mining.approval.prepare", { input: {} })).ok).toBe(true);
    expect((await rpcReq(admin, "wen.mining.approval.begin", { input: {} })).ok).toBe(true);
    expect(
      (
        await rpcReq(admin, "wen.mining.approval.finish", {
          challengeId: "fixture",
          credential: {},
        })
      ).ok,
    ).toBe(true);
    expect(profile.finishClaimApproval).toHaveBeenCalledOnce();
    expect(
      (await rpcReq(admin, "wen.mining.approval.execute", { requestId: "fixture-request" })).ok,
    ).toBe(true);
    expect(
      (await rpcReq(admin, "wen.mining.approval.execute", { requestId: "fixture-request" })).ok,
    ).toBe(false);
    expect(
      (await rpcReq(admin, "wen.mining.approval.recover", { requestId: "fixture-request" })).ok,
    ).toBe(true);
    expect(profile.runClaimJourney).toHaveBeenCalledTimes(2);
    const accepted = await rpcReq(admin, "wen.mining.review.refresh", {});
    expect(accepted.ok).toBe(true);
    expect(accepted.payload).toMatchObject({
      mode: "local-candidate-only",
      signingEnabled: false,
      payload: { items: [], signingEnabled: false },
    });
    expect(profile.refreshReviewPage).toHaveBeenCalledOnce();
    profile.refreshReviewPage.mockResolvedValue({
      items: [
        {
          entry: "joined-entry",
          status: "requires-review",
          reviewDraft: {
            descriptor: "e30=",
            review: {
              walletId: "joined-miner",
              walletPublicKey: "joined-owner",
              intent: {
                programId: "joined-program",
                economy: "joined-economy",
                operation: "sat",
                expectedGross: "20",
                minimumReceived: "19",
                maxFeeLamports: "5000",
                expiresSlot: "132",
              },
            },
          },
        },
      ],
      signingEnabled: false,
      nextCursor: "",
      scanComplete: true,
    } as never);
    browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
    const page = await browser.newPage();
    await page.goto(uiUrl + "/wen-review-fixture");
    const token =
      (testState.gatewayAuth as { token?: string })?.token ?? process.env.FASED_GATEWAY_TOKEN;
    if (!token) {
      throw Error("Missing gateway test token");
    }
    await page.addScriptTag({
      type: "module",
      content:
        'import {GatewayBrowserClient} from "/src/ui/gateway.ts"; import "/src/ui/views/wen-review.ts"; import "/src/ui/views/wen-economy.ts"; import "/src/ui/views/wen-acquisition.ts"; window.WenGatewayClient = GatewayBrowserClient;',
    });
    await page.waitForFunction(() => "WenGatewayClient" in window);
    await page.evaluate(
      async ({ port, token }) => {
        const GatewayBrowserClient = (
          window as unknown as Window & {
            WenGatewayClient: typeof import("../../ui/src/ui/gateway.js").GatewayBrowserClient;
          }
        ).WenGatewayClient;
        const client = await new Promise<BrowserClient>((resolve, reject) => {
          const candidate = new GatewayBrowserClient({
            url: "ws://127.0.0.1:" + port,
            token,
            onHello: () => resolve(candidate),
            onClose: (info: { reason: string }) => reject(Error(info.reason)),
          });
          candidate.start();
        });
        const panel = document.createElement("wen-review-panel") as WenReviewPanel;
        panel.client = client;
        panel.connected = true;
        document.body.append(panel);
        const economyPanel = document.createElement("wen-economy-panel");
        economyPanel.client = client;
        economyPanel.connected = true;
        document.body.append(economyPanel);
        const acquisitionPanel = document.createElement(
          "wen-acquisition-panel",
        ) as unknown as WenReviewPanel;
        acquisitionPanel.client = client;
        acquisitionPanel.connected = true;
        document.body.append(acquisitionPanel);
        await panel.updateComplete;
        (window as unknown as Window & { wenTestClient: BrowserClient }).wenTestClient = client;
      },
      { uiUrl, port, token },
    );
    await page.getByRole("button", { name: "Refresh unsigned reviews" }).click();
    await page.getByRole("button", { name: "Refresh facts" }).click();
    await page.getByText("Unavailable: Coverage incomplete").waitFor();
    await page
      .getByLabel("Owner public address")
      .fill("C9y1TCfmUh3DbCpec1GvuuWdV4EYcE2N23tsgcUbgJ4N");
    await page.getByLabel("Net quantity in smallest asset units").fill("100000000000");
    await page.getByRole("button", { name: "Prepare WEN request", exact: true }).click();
    const handoffLink = page.getByRole("link", { name: "Review in WEN", exact: true });
    await handoffLink.waitFor();
    const handoffRequest = JSON.parse(
      new URLSearchParams(new URL((await handoffLink.getAttribute("href"))!).hash.slice(1)).get(
        "wen-request",
      )!,
    );
    expect(handoffRequest.owner).toBe("C9y1TCfmUh3DbCpec1GvuuWdV4EYcE2N23tsgcUbgJ4N");
    expect(handoffRequest.netAtoms).toBe("100000000000");

    await page
      .getByText(
        "SAT gross: 20; minimum received: 19; maximum fee: 5000 lamports; expiry slot: 132.",
      )
      .waitFor();
    await page
      .getByText(
        "Wallet: joined-miner (joined-owner). Program: joined-program. Economy: joined-economy.",
      )
      .waitFor();
    expect(await page.getByRole("button", { name: "Refresh unsigned reviews" }).isVisible()).toBe(
      true,
    );
    expect(await page.getByRole("button", { name: "Export review JSON" }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Refresh admitted claim" }).isDisabled()).toBe(
      true,
    );
    const downloadReady = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export review JSON" }).click();
    const download = await downloadReady;
    expect(download.suggestedFilename()).toBe("wen-claim-review.json");
    const downloaded = await download.path();
    if (!downloaded) {
      throw Error("Review download missing");
    }
    expect(JSON.parse(await readFile(downloaded, "utf8"))).toMatchObject({
      descriptor: "e30=",
      review: { walletId: "joined-miner", intent: { expectedGross: "20", minimumReceived: "19" } },
    });
    expect(profile.refreshReviewPage).toHaveBeenCalledTimes(2);
    await page.evaluate(() => {
      (window as unknown as Window & { wenTestClient: BrowserClient }).wenTestClient.stop();
    });
  } finally {
    await browser?.close();
    await uiServer?.close();
    await new Promise<void>((resolve) => readServer?.close(() => resolve()) ?? resolve());
    for (const ws of sockets) {
      ws.terminate();
    }
    await server?.close();
    await service?.stop({ stateDir: dir });
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});
