import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { expect, test, vi } from "vitest";
import plugin from "../../extensions/sat-mining/index.js";
import { createServer } from "../../ui/node_modules/vite/dist/node/index.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  getFreePort,
  installGatewayTestHooks,
  setTestPluginRegistry,
  startGatewayServer,
  testState,
} from "./test-helpers.js";

// Diagnostic wrapper only: all values and failures come from the real profile.
vi.mock("fased/plugin-sdk/sat-runtime", async (original) => {
  const actual = await original<typeof import("../plugin-sdk/sat-runtime.js")>();
  return {
    ...actual,
    async createLocalWenRecoveryProfile(
      ...args: Parameters<typeof actual.createLocalWenRecoveryProfile>
    ) {
      const profile = await actual.createLocalWenRecoveryProfile(...args);
      return new Proxy(profile, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (
            typeof value !== "function" ||
            ![
              "prepareClaimApproval",
              "beginClaimApproval",
              "finishClaimApproval",
              "runClaimJourney",
            ].includes(String(key))
          ) {
            return value;
          }
          return async (...params: unknown[]) => {
            try {
              return await Reflect.apply(value, target, params);
            } catch (error) {
              console.error(
                "funded profile rejected",
                String(key),
                error instanceof Error ? error.message : "unknown error",
              );
              throw error;
            }
          };
        },
      });
    },
  };
});

type BrowserClient = import("../../ui/src/ui/gateway.js").GatewayBrowserClient;
type FundedWindow = Window & {
  fundedModules: {
    GatewayBrowserClient: typeof import("../../ui/src/ui/gateway.js").GatewayBrowserClient;
    approveWenClaim: typeof import("../../ui/src/ui/wen-claim-approval.js").approveWenClaim;
  };
  fundedClient: BrowserClient;
  fundedResult?: unknown;
  fundedError?: string;
};

installGatewayTestHooks({ scope: "suite" });
test.skipIf(!process.env.WEN_FUNDED_BROWSER_INPUT)(
  "funded browser uses actual profile and signer socket",
  { timeout: 90000 },
  async () => {
    const input = JSON.parse(await readFile(process.env.WEN_FUNDED_BROWSER_INPUT!, "utf8"));
    const registry = createEmptyPluginRegistry();
    let service!: {
      start(c: { stateDir: string }): Promise<void>;
      stop(c: { stateDir: string }): Promise<void>;
    };
    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let ui: Awaited<ReturnType<typeof createServer>> | undefined;
    let executions = 0;
    let recoveries = 0;
    const context = { stateDir: path.dirname(input.profilePath) };
    try {
      vi.stubEnv("FASED_WEN_LOCAL_RECOVERY_PROFILE", input.profilePath);
      plugin.register({
        registerGatewayMethod(
          name: string,
          handler: (typeof registry.gatewayHandlers)[string],
          opts?: { scope: "operator.admin" },
        ) {
          registry.gatewayHandlers[name] = async (ctx) => {
            if (name === "wen.mining.approval.execute") {
              executions++;
              // Lose only the successful reply, after the real handler executes.
              return handler({
                ...ctx,
                respond(ok, payload, error) {
                  ctx.respond(
                    false,
                    undefined,
                    ok ? { code: "UNAVAILABLE", message: "fixture lost execution reply" } : error,
                  );
                },
              });
            }
            if (name === "wen.mining.approval.recover") {
              recoveries++;
            }
            return handler(ctx);
          };
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
      await service.start(context);
      ui = await createServer({
        configFile: false,
        root: path.resolve("ui"),
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { host: "127.0.0.1", port: await getFreePort() },
      });
      ui.middlewares.use((req, res, next) => {
        if (req.url !== "/funded-claim") {
          return next();
        }
        res.setHeader("Content-Type", "text/html");
        res.end('<!doctype html><button id="approve">Approve funded claim</button>');
      });
      await ui.listen();
      const local = ui.resolvedUrls!.local[0].replace(/\/$/, "");
      testState.gatewayControlUi = { allowedOrigins: [input.origin] };
      const port = await getFreePort();
      server = await startGatewayServer(port);
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.route(input.origin + "/**", async (route) => {
        if (new URL(route.request().url()).pathname === "/funded-claim") {
          await route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><button id="approve">Approve funded claim</button>',
          });
          return;
        }
        const response = await route.fetch({
          url: local + new URL(route.request().url()).pathname,
        });
        await route.fulfill({ response });
      });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "usb",
          hasResidentKey: false,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      await cdp.send("WebAuthn.addCredential", {
        authenticatorId,
        credential: {
          credentialId: input.credentialId,
          isResidentCredential: false,
          rpId: input.rpId,
          privateKey: input.privateKey,
          signCount: 1,
        },
      });
      await page.goto(input.origin + "/funded-claim");
      await page.addScriptTag({
        type: "module",
        content:
          'import {GatewayBrowserClient} from "/src/ui/gateway.ts"; import {approveWenClaim} from "/src/ui/wen-claim-approval.ts"; window.fundedModules={GatewayBrowserClient,approveWenClaim};',
      });
      await page.waitForFunction(() => "fundedModules" in window);
      const token =
        (testState.gatewayAuth as { token?: string })?.token ?? process.env.FASED_GATEWAY_TOKEN;
      expect(token).toBeTruthy();
      await page.evaluate(
        async ({ port, token, walletId, request }) => {
          const w = window as unknown as FundedWindow;
          const { GatewayBrowserClient, approveWenClaim } = w.fundedModules;
          const client = await new Promise<BrowserClient>((resolve, reject) => {
            const value = new GatewayBrowserClient({
              url: "ws://127.0.0.1:" + port,
              token,
              onHello: () => resolve(value),
              onClose: (v: { reason: string }) => reject(Error(v.reason)),
            });
            value.start();
          });
          w.fundedClient = client;
          document.getElementById("approve")!.addEventListener("click", () => {
            void approveWenClaim(client, walletId, request, new AbortController().signal)
              .then((value: unknown) => {
                w.fundedResult = value;
              })
              .catch((error: Error) => {
                w.fundedError = error.message;
              });
          });
        },
        { port, token, walletId: input.walletId, request: input.request },
      );
      await page.click("#approve");
      await page.waitForFunction(() => "fundedResult" in window || "fundedError" in window);
      expect(
        await page.evaluate(() => (window as unknown as FundedWindow).fundedError),
      ).toBeUndefined();
      expect(
        await page.evaluate(() => (window as unknown as FundedWindow).fundedResult),
      ).toMatchObject({
        requestId: input.request.requestId,
        walletId: input.walletId,
        outcome: "finalized-success",
        recoveryRequired: false,
      });
      expect(executions).toBe(1);
      expect(recoveries).toBe(1);
      await service.stop(context);
      await service.start(context);
      const recovered = await page.evaluate(
        (requestId) =>
          (window as unknown as FundedWindow).fundedClient.request<{ payload: unknown }>(
            "wen.mining.approval.recover",
            { requestId },
          ),
        input.request.requestId,
      );
      expect(recovered.payload).toMatchObject({
        outcome: "finalized-success",
        walletId: input.walletId,
      });
      expect(executions).toBe(1);
      expect(recoveries).toBe(2);
      await page.evaluate(() => (window as unknown as FundedWindow).fundedClient.stop());
    } finally {
      for (const context of browser?.contexts() ?? []) {
        await context.unrouteAll({ behavior: "wait" });
        for (const page of context.pages()) {
          await page.unrouteAll({ behavior: "wait" });
        }
      }
      await browser?.close();
      await ui?.close();
      await service?.stop(context);
      await server?.close();
      vi.unstubAllEnvs();
    }
  },
);
