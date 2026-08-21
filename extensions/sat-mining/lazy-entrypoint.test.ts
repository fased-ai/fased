import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SAT_MINING_GATEWAY_METHODS } from "fased/plugin-sdk/sat-runtime";
import { afterEach, describe, expect, it } from "vitest";
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
  it("activates only for configuration, Wallet attachment, or durable recovery state", async () => {
    const stateDir = await temporaryStateDir();
    const api = { pluginConfig: undefined } as never;
    const context = { stateDir } as never;
    await expect(shouldActivateMining(api, context)).resolves.toBe(false);

    await expect(
      shouldActivateMining({ pluginConfig: { enabled: true } } as never, context),
    ).resolves.toBe(true);

    await fs.mkdir(path.join(stateDir, "wallet"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "wallet", "provider-registry.v1.json"), "{}\n");
    await expect(shouldActivateMining(api, context)).resolves.toBe(true);
    await fs.rm(path.join(stateDir, "wallet"), { recursive: true });

    await fs.mkdir(path.join(stateDir, "sat-mining", "wallets", "vault"), { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "sat-mining", "wallets", "vault", "mining.sqlite"),
      "recovery",
    );
    await expect(shouldActivateMining(api, context)).resolves.toBe(true);
  });

  it("registers only the stable Gateway facade and one bootstrap service while dormant", async () => {
    const stateDir = await temporaryStateDir();
    const gatewayMethods: string[] = [];
    const services: Array<{ id: string; start: (context: unknown) => Promise<void> }> = [];
    let operationalRegistrations = 0;
    satMiningPlugin.register({
      pluginConfig: undefined,
      registerGatewayMethod(method: string) {
        gatewayMethods.push(method);
      },
      registerService(service: (typeof services)[number]) {
        services.push(service as (typeof services)[number]);
      },
      registerCommand() {
        operationalRegistrations += 1;
      },
      registerTool() {
        operationalRegistrations += 1;
      },
      logger: { info() {} },
    } as never);

    expect(gatewayMethods).toEqual(SAT_MINING_GATEWAY_METHODS);
    expect(services.map((service) => service.id)).toEqual(["sat-mining"]);
    expect(operationalRegistrations).toBe(0);
    await services[0].start({ stateDir } as never);
    expect(operationalRegistrations).toBe(0);
  });
});
