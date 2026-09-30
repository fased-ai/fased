import { chromium } from "playwright-core";
import { expect, test } from "vitest";
import { WebSocket } from "ws";
import { registerWenApprovalGateway } from "../../extensions/sat-mining/src/wen-approval-gateway.js";
import { createServer } from "../../ui/node_modules/vite/dist/node/index.js";
import { startCampaignWireFixture } from "../../ui/test/wen-campaign-wire-fixture.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
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
installGatewayTestHooks({ scope: "suite" });

test.each(["stop", "setup", "policy", "claim", "claim-stake", "buy"] as const)(
  "campaign %s browser uses authenticated admin WebSocket and compiled signer",
  { timeout: 120000 },
  async (operation) => {
    let ui: Awaited<ReturnType<typeof createServer>> | undefined;
    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    let fixture: Awaited<ReturnType<typeof startCampaignWireFixture>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let cancel: (() => void) | undefined;
    const sockets: WebSocket[] = [];
    const namespace = operation === "buy" ? "wen.market.approval" : "wen.campaign.approval";
    let completed = false;
    let cleanupError: unknown;
    try {
      ui = await createServer({
        configFile: false,
        root: "ui",
        optimizeDeps: { noDiscovery: true, include: ["@solana/web3.js"] },
        server: { host: "127.0.0.1", port: await getFreePort() },
      });
      ui.middlewares.use((req, res, next) => {
        if (req.url !== "/campaign-test") {
          next();
          return;
        }
        res.setHeader("Content-Type", "text/html");
        res.end("<!doctype html><html><body></body></html>");
      });
      await ui.listen();
      const uiUrl = ui.resolvedUrls!.local[0].replace(/\/$/, "").replace("127.0.0.1", "localhost");
      fixture = await startCampaignWireFixture(uiUrl, operation);
      const registry = createEmptyPluginRegistry();
      let dropFirstBuyRecovery = operation === "buy";
      const profile =
        operation === "buy"
          ? {
              ...fixture.profile,
              async runClaimJourney(requestId: string, action: "execute" | "recover") {
                const result = await fixture!.profile.runClaimJourney(requestId, action);
                if (action === "recover" && dropFirstBuyRecovery) {
                  dropFirstBuyRecovery = false;
                  throw Error("test-only dropped reconciliation response");
                }
                return result;
              },
            }
          : fixture.profile;
      cancel = registerWenApprovalGateway(
        {
          registerGatewayMethod(name, handler, options) {
            registry.gatewayHandlers[name] = handler;
            if (options) {
              registry.gatewayMethodScopes[name] = options.scope;
            }
          },
        },
        () => profile,
        namespace,
      );
      setTestPluginRegistry(registry);
      testState.gatewayControlUi = { allowedOrigins: [uiUrl] };
      const port = await getFreePort();
      server = await startGatewayServer(port);
      async function open() {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        trackConnectChallengeNonce(ws);
        sockets.push(ws);
        await new Promise<void>((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        });
        return ws;
      }
      const wrong = await open();
      expect((await connectReq(wrong, { token: "invalid-fixture-token" })).ok).toBe(false);
      const reader = await open();
      expect((await connectReq(reader, { scopes: ["operator.read"] })).ok).toBe(true);
      for (const method of [
        "selection",
        "prepare",
        "begin",
        "finish",
        "cancel",
        "execute",
        "recover",
      ]) {
        const result = await rpcReq(reader, namespace + "." + method, {});
        expect(result.ok).toBe(false);
        expect(result.error?.message).toContain("operator.admin");
      }
      browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable });
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      await page.goto(uiUrl + "/campaign-test");
      await page.addScriptTag({
        type: "module",
        content:
          'try { const {GatewayBrowserClient}=await import("/src/ui/gateway.ts"); await import("/src/ui/views/wen-campaign.ts"); window.WenGatewayClient=GatewayBrowserClient; } catch(error) { window.WenGatewayError=String(error); }',
      });
      await page.waitForFunction(() => "WenGatewayClient" in window || "WenGatewayError" in window);
      const moduleError = await page.evaluate(
        () => (window as unknown as { WenGatewayError?: string }).WenGatewayError,
      );
      if (moduleError) {
        throw Error(moduleError);
      }
      const token = (testState.gatewayAuth as { token: string }).token;
      const result = await page.evaluate(
        async ({ port, token, enrollmentUrl, operation }) => {
          type Client = import("../../ui/src/ui/gateway.js").GatewayBrowserClient;
          const Constructor = (
            window as unknown as Window & {
              WenGatewayClient: typeof import("../../ui/src/ui/gateway.js").GatewayBrowserClient;
            }
          ).WenGatewayClient;
          const client = await new Promise<Client>((resolve, reject) => {
            const c = new Constructor({
              url: `ws://127.0.0.1:${port}`,
              token,
              onHello: () => resolve(c),
              onClose: (info) => reject(Error(info.reason)),
            });
            c.start();
          });
          try {
            const enrollment = async (method: string, params: unknown) => {
              const response = await fetch(enrollmentUrl, {
                method: "POST",
                body: JSON.stringify({ method, params }),
              });
              if (!response.ok) {
                throw Error("enrollment failed");
              }
              return response.json();
            };
            const begin = await enrollment("test.registration.begin", {
              label: "WS integration fixture",
            });
            const decode = (v: string) =>
              Uint8Array.from(atob(v.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
                c.charCodeAt(0),
              );
            const encode = (v: ArrayBuffer) =>
              btoa(String.fromCharCode(...new Uint8Array(v)))
                .replaceAll("+", "-")
                .replaceAll("/", "_")
                .replaceAll("=", "");
            const options = begin.options.publicKey;
            const credential = (await navigator.credentials.create({
              publicKey: {
                ...options,
                challenge: decode(options.challenge),
                user: { ...options.user, id: decode(options.user.id) },
                excludeCredentials: [],
              },
            })) as PublicKeyCredential;
            const response = credential.response as AuthenticatorAttestationResponse;
            await enrollment("test.registration.finish", {
              challengeId: begin.challengeId,
              credential: {
                id: credential.id,
                rawId: encode(credential.rawId),
                type: "public-key",
                response: {
                  clientDataJSON: encode(response.clientDataJSON),
                  attestationObject: encode(response.attestationObject),
                  transports: response.getTransports(),
                },
                clientExtensionResults: credential.getClientExtensionResults(),
              },
            });
            const panel = document.createElement(
              "wen-campaign-panel",
            ) as import("../../ui/src/ui/views/wen-campaign.js").WenCampaignPanel;
            panel.domain = operation === "buy" ? "market" : "campaign";
            panel.client = client;
            panel.connected = true;
            document.body.append(panel);
            await panel.updateComplete;
            await panel.loadConfigured();
            await panel.updateComplete;
            await panel.refresh();
            await panel.updateComplete;
            if (!panel.verified) {
              throw Error(panel.status);
            }
            const reviewText = panel.textContent;
            await Promise.all([panel.approve(), panel.approve()]);
            await panel.updateComplete;
            if (operation === "buy") {
              if (!panel.pending || !panel.status.includes("unresolved")) {
                throw Error("lost recovery was not retained");
              }
              const saved = sessionStorage.getItem(
                `wen.market.pending:${panel.host && "pins" in panel.host.expected ? panel.host.expected.policy.Successor.Genesis : ""}:${panel.host?.expected.walletId}`,
              );
              if (!saved) {
                throw Error("Buy recovery identity not persisted");
              }
              panel.remove();
              const restored = document.createElement(
                "wen-campaign-panel",
              ) as import("../../ui/src/ui/views/wen-campaign.js").WenCampaignPanel;
              restored.domain = "market";
              restored.client = client;
              restored.connected = true;
              document.body.append(restored);
              await restored.updateComplete;
              await restored.loadConfigured();
              await restored.updateComplete;
              await restored.refresh();
              await restored.updateComplete;
              if (!restored.pending || restored.verified) {
                throw Error("restored Buy attempted a new review");
              }
              await restored.recover();
              await restored.updateComplete;
              return { status: restored.status, pending: restored.pending, text: reviewText };
            }
            return { status: panel.status, pending: panel.pending, text: reviewText };
          } finally {
            client.stop();
          }
        },
        { port, token, enrollmentUrl: fixture.url, operation },
      );
      expect(result.status).toContain("finalized-success");
      expect(result.pending).toBeNull();
      if (operation === "setup") {
        expect(result.text).toContain("rent");
        expect(result.text).toContain("Setup deposit");
      }
      if (operation === "policy") {
        expect(result.text).toContain("Future mining policy");
        expect(result.text).toContain("historical claims are preserved");
      }
      if (operation === "claim") {
        expect(result.text).toContain("Claim net SAT 970");
        expect(result.text).toContain("not charged again");
      }
      if (operation === "claim-stake") {
        expect(result.text).toContain("net stake credit");
        expect(result.text).toContain("Pool custody");
        expect(result.text).toContain("not charged again");
      }
      if (operation === "buy") {
        expect(result.text).toContain("Minimum net SAT");
        expect(result.text).toContain("Network fee ceiling");
        expect(result.text).toContain("retained SOL");
      }
      completed = true;
    } finally {
      await browser?.close();
      for (const ws of sockets) {
        ws.terminate();
      }
      await server?.close();
      cancel?.();
      await ui?.close();
      try {
        await fixture?.stop();
      } catch (error) {
        cleanupError = error;
      }
    }
    if (completed && cleanupError) {
      throw cleanupError;
    }
    expect(fixture!.events.filter((e) => e.endsWith(":execute"))).toHaveLength(1);
    expect(fixture!.events.filter((e) => e.endsWith(":recover"))).toHaveLength(
      operation === "buy" ? 2 : 1,
    );
    expect(fixture!.events).toContain("cryptographic-assertion-verified");
  },
);
