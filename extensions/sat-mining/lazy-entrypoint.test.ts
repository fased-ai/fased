import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SAT_MINING_GATEWAY_METHODS } from "fased/plugin-sdk/sat-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import satMiningPlugin, { shouldActivateMining } from "./index.js";

const temporaryRoots: string[] = [];

async function temporaryStateDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-mining-lazy-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("SAT Mining lazy registration facade", () => {
  it("activates only for explicit legacy configuration or durable recovery state", async () => {
    const stateDir = await temporaryStateDir();
    const api = { pluginConfig: undefined } as never;
    const context = { stateDir } as never;
    await expect(shouldActivateMining(api, context)).resolves.toBe(false);

    await expect(
      shouldActivateMining({ pluginConfig: { enabled: true } } as never, context),
    ).resolves.toBe(true);

    await fs.mkdir(path.join(stateDir, "wallet"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "wallet", "provider-registry.v1.json"), "{}\n");
    await expect(shouldActivateMining(api, context)).resolves.toBe(false);
    await fs.rm(path.join(stateDir, "wallet"), { recursive: true });

    await fs.mkdir(path.join(stateDir, "sat-mining", "wallets", "vault"), { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "sat-mining", "wallets", "vault", "mining.sqlite"),
      "recovery",
    );
    await expect(shouldActivateMining(api, context)).resolves.toBe(true);
  });

  it("registers a read-only WEN agent tool without activating legacy mining", async () => {
    const stateDir = await temporaryStateDir();
    const gatewayMethods: string[] = [];
    const services: Array<{ id: string; start: (context: unknown) => Promise<void> }> = [];
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
    let operationalRegistrations = 0;
    satMiningPlugin.register({
      pluginConfig: undefined,
      registerGatewayMethod(method: string) {
        gatewayMethods.push(method);
      },
      registerService(service: (typeof services)[number]) {
        services.push(service);
      },
      registerCommand() {
        operationalRegistrations += 1;
      },
      registerTool(tool: (typeof tools)[number]) {
        tools.push(tool);
      },
      logger: { info() {} },
    } as never);

    expect(gatewayMethods).toEqual([
      ...SAT_MINING_GATEWAY_METHODS,
      "wen.mining.review.refresh",
      "wen.mining.claim.refresh",
      "wen.economy.read",
      "wen.acquisition.handoff",
      "wen.mining.approval.prepare",
      "wen.mining.approval.begin",
      "wen.mining.approval.finish",
      "wen.mining.approval.cancel",
      "wen.mining.approval.execute",
      "wen.mining.approval.recover",
      "wen.campaign.approval.prepare",
      "wen.campaign.approval.begin",
      "wen.campaign.approval.finish",
      "wen.campaign.approval.cancel",
      "wen.campaign.approval.execute",
      "wen.campaign.approval.recover",
      "wen.campaign.approval.selection",
    ]);
    expect(services.map((service) => service.id)).toEqual(["sat-mining"]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "wen_economy_facts",
      "wen_acquisition_request",
    ]);
    expect(operationalRegistrations).toBe(0);
    await services[0].start({ stateDir } as never);
    expect(operationalRegistrations).toBe(0);
    expect(await tools[0].execute("read-1", {})).toEqual(
      expect.objectContaining({
        details: { status: "unavailable", reason: "No pinned local WEN economy read" },
      }),
    );
  });

  it("rejects new legacy cycle calls without activating the personal miner", async () => {
    const stateDir = await temporaryStateDir();
    await fs.mkdir(path.join(stateDir, "wallet"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "wallet", "provider-registry.v1.json"), "{}\n");
    const handlers = new Map<string, (context: unknown) => Promise<void>>();
    let start: ((context: unknown) => Promise<void>) | undefined;
    let operationalRegistrations = 0;
    satMiningPlugin.register({
      pluginConfig: undefined,
      registerGatewayMethod(method: string, handler: (context: unknown) => Promise<void>) {
        handlers.set(method, handler);
      },
      registerService(service: { start(context: unknown): Promise<void> }) {
        start = service.start;
      },
      registerCommand() {
        operationalRegistrations++;
      },
      registerTool(tool: { name: string }) {
        if (!["wen_economy_facts", "wen_acquisition_request"].includes(tool.name)) {
          operationalRegistrations++;
        }
      },
      logger: { info() {} },
    } as never);
    await start?.({ stateDir });
    const replies: unknown[] = [];
    await handlers.get(SAT_MINING_GATEWAY_METHODS[0])?.({
      params: {},
      respond: (...args: unknown[]) => replies.push(args),
    });
    expect(replies).toEqual([[false, undefined, expect.objectContaining({ code: "UNAVAILABLE" })]]);
    expect(operationalRegistrations).toBe(0);
  });

  it("serves a pinned read-only economy snapshot without activating legacy mining", async () => {
    const stateDir = await temporaryStateDir();
    const profilePath = path.join(stateDir, "wen-read.json");
    const pin = {
      economy: "sat-v1",
      genesis: "genesis",
      program: "program",
      mint: "mint",
      deployedBytesHash: "a".repeat(64),
      deploymentSlot: "12",
      upgradeAuthority: null,
    };
    await fs.writeFile(
      profilePath,
      JSON.stringify({ url: "http://127.0.0.1:3015/api/v1/economies/sat-v1/factsheet", pin }),
    );
    const handlers = new Map<string, (context: unknown) => Promise<void>>();
    let start: ((context: unknown) => Promise<void>) | undefined;
    let stop: ((context: unknown) => Promise<void>) | undefined;
    let scope = "";
    let agentTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    process.env.FASED_WEN_LOCAL_READ_PROFILE = profilePath;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            schema: "wen.economy.read.v1",
            mode: "local-devnet-read-only",
            signingEnabled: false,
            identity: {
              economy: pin.economy,
              genesis: pin.genesis,
              program: pin.program,
              mint: pin.mint,
            },
            deployment: {
              deployedBytesHash: pin.deployedBytesHash,
              deploymentSlot: pin.deploymentSlot,
              upgradeAuthority: null,
            },
            slot: "13",
            observedAtMs: Date.now(),
            rows: [
              ...["issuedSupply", "unmintedObligations", "protocolAsset"].map((id) => ({
                id,
                status: "reported",
                value: "10",
                unit: "atoms",
                evidence: "onchain",
                source: "account",
                scope: "Current account",
                observedAtMs: Date.now(),
              })),
              {
                id: "economicNav",
                status: "unavailable",
                value: null,
                reason: "Coverage incomplete",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    try {
      satMiningPlugin.register({
        pluginConfig: undefined,
        registerGatewayMethod(
          method: string,
          handler: (context: unknown) => Promise<void>,
          options?: { scope: string },
        ) {
          handlers.set(method, handler);
          if (method === "wen.economy.read") scope = options?.scope ?? "";
        },
        registerService(service: {
          start(context: unknown): Promise<void>;
          stop(context: unknown): Promise<void>;
        }) {
          start = service.start;
          stop = service.stop;
        },
        registerTool(tool: typeof agentTool & { name: string }) {
          if (tool.name === "wen_economy_facts") agentTool = tool;
        },
        logger: { info() {} },
      } as never);
      await start?.({ stateDir });
      const replies: unknown[] = [];
      await handlers.get("wen.economy.read")?.({
        params: {},
        respond: (...args: unknown[]) => replies.push(args),
      });
      expect(scope).toBe("operator.read");
      expect(replies[0]).toEqual([
        true,
        expect.objectContaining({
          signingEnabled: false,
          rows: expect.arrayContaining([
            expect.objectContaining({ id: "economicNav", status: "unavailable" }),
          ]),
        }),
      ]);
      const agentRead = await agentTool!.execute("read-2", {});
      expect(agentRead).toEqual(
        expect.objectContaining({
          details: expect.objectContaining({
            status: "verified-local-read-only",
            signingEnabled: false,
            rows: expect.arrayContaining([
              expect.objectContaining({ id: "economicNav", status: "unavailable" }),
            ]),
          }),
        }),
      );
      await stop?.({ stateDir });
      expect(await agentTool!.execute("read-3", {})).toEqual(
        expect.objectContaining({
          details: { status: "unavailable", reason: "No pinned local WEN economy read" },
        }),
      );
    } finally {
      delete process.env.FASED_WEN_LOCAL_READ_PROFILE;
      fetcher.mockRestore();
    }
  });
});
