import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";

it("registers only WEN routes and never activates the deleted miner from old state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wen-only-"));
  try {
    await fs.mkdir(path.join(root, "sat-mining/wallets/old"), { recursive: true });
    await fs.writeFile(path.join(root, "sat-mining/wallets/old/mining.sqlite"), "old fixture");
    const methods: string[] = [];
    const tools: string[] = [];
    const commands = vi.fn();
    let service!: {
      id: string;
      start(context: unknown): Promise<void>;
      stop(context: unknown): Promise<void>;
    };
    plugin.register({
      pluginConfig: { enabled: true, drainOnly: true },
      registerGatewayMethod(name: string) {
        methods.push(name);
      },
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
      registerService(value: typeof service) {
        service = value;
      },
      registerCommand: commands,
      logger: { info() {}, warn() {} },
    } as never);
    expect(plugin.id).toBe("wen");
    expect(methods).toHaveLength(25);
    expect(methods.every((name) => name.startsWith("wen."))).toBe(true);
    expect(methods).toContain("wen.market.approval.execute");
    expect(methods).toContain("wen.mining.approval.recover");
    expect(methods).toContain("wen.campaign.approval.execute");
    expect(tools).toEqual(["wen_economy_facts", "wen_acquisition_request"]);
    expect(service.id).toBe("wen");
    await service.start({ stateDir: root });
    await service.stop({ stateDir: root });
    expect(commands).not.toHaveBeenCalled();
    expect(plugin.configSchema.jsonSchema.additionalProperties).toBe(false);
    expect(plugin.configSchema.jsonSchema.properties).toEqual({});
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
