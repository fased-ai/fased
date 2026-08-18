import { describe, expect, it, vi } from "vitest";
import { createGatewayConfigurationFacade } from "./configuration-facade.js";

describe("Gateway configuration facade", () => {
  it("prepares, validates, persists, and activates one configuration transaction", async () => {
    const original = { gateway: { port: 18789 } };
    const activated = { gateway: { port: 19000, bind: "loopback" } };
    const readSnapshotForWrite = vi
      .fn()
      .mockResolvedValueOnce({
        snapshot: { valid: true, resolved: original, config: original },
        writeOptions: { expectedConfigPath: "/tmp/fased.json" },
      })
      .mockResolvedValueOnce({
        snapshot: { valid: true, resolved: activated, config: activated },
        writeOptions: { expectedConfigPath: "/tmp/fased.json" },
      });
    const validateConfig = vi.fn((config) => ({ ok: true, config }));
    const writeConfig = vi.fn(async () => undefined);
    const activateRuntime = vi.fn();
    const facade = createGatewayConfigurationFacade({
      readSnapshotForWrite: readSnapshotForWrite as never,
      validateConfig: validateConfig as never,
      writeConfig: writeConfig as never,
      activateRuntime,
    });

    const result = await facade.update({
      prepare: (config) => {
        config.gateway = { ...config.gateway, bind: "loopback" };
      },
      mutate: (config) => {
        config.gateway = { ...config.gateway, port: 19000 };
      },
    });

    expect(result).toEqual({ ok: true, config: activated });
    expect(original).toEqual({ gateway: { port: 18789 } });
    expect(validateConfig).toHaveBeenCalledWith({
      gateway: { port: 19000, bind: "loopback" },
    });
    expect(writeConfig).toHaveBeenCalledWith(
      { gateway: { port: 19000, bind: "loopback" } },
      { expectedConfigPath: "/tmp/fased.json" },
    );
    expect(activateRuntime).toHaveBeenCalledWith(activated, activated);
  });

  it("fails closed before persistence when mutation or validation fails", async () => {
    const readSnapshotForWrite = vi.fn(async () => ({
      snapshot: { valid: true, resolved: {}, config: {} },
      writeOptions: {},
    }));
    const writeConfig = vi.fn(async () => undefined);
    const mutationFacade = createGatewayConfigurationFacade({
      readSnapshotForWrite: readSnapshotForWrite as never,
      validateConfig: vi.fn() as never,
      writeConfig: writeConfig as never,
    });

    await expect(
      mutationFacade.update({
        mutate: () => {
          throw new Error("rejected mutation");
        },
      }),
    ).resolves.toEqual({ ok: false, message: "Error: rejected mutation" });

    const validationFacade = createGatewayConfigurationFacade({
      readSnapshotForWrite: readSnapshotForWrite as never,
      validateConfig: vi.fn(() => ({
        ok: false,
        issues: [
          { path: "gateway.port", message: "must be positive" },
          { path: "", message: "invalid root" },
          { path: "hooks", message: "invalid hooks" },
          { path: "ignored", message: "fourth issue" },
        ],
      })) as never,
      writeConfig: writeConfig as never,
    });

    await expect(validationFacade.update({ mutate: () => undefined })).resolves.toEqual({
      ok: false,
      message: "gateway.port: must be positive; <root>: invalid root; hooks: invalid hooks",
    });
    expect(writeConfig).not.toHaveBeenCalled();
  });
});
