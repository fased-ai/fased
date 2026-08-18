import { describe, expect, it, vi } from "vitest";
import { createWalletMiningRotationFacade } from "./wallet-mining-rotation-facade.js";

const commandMocks = vi.hoisted(() => ({
  retireAndReplace: vi.fn(async () => undefined),
}));

vi.mock("../commands/wallet.js", () => ({
  walletRetireCommand: commandMocks.retireAndReplace,
}));

describe("Wallet Mining rotation facade", () => {
  const options = {
    walletId: "mining",
    successorWalletId: "mining-successor",
    successorWalletName: "Mining Successor",
    recoveryFile: "/tmp/mining-recovery.json",
    rpcUrl: "https://rpc.example.test",
    liveMiningStatus: { active: false },
    json: true,
  };

  it("routes retirement and replacement through one typed boundary", async () => {
    const retireAndReplace = vi.fn(async () => undefined);
    const facade = createWalletMiningRotationFacade({ retireAndReplace });
    const runtime = { log: vi.fn() };

    await facade.retireAndReplace(runtime as never, options);

    expect(retireAndReplace).toHaveBeenCalledWith(runtime, options);
  });

  it("lazily forwards the default facade to the existing rotation command", async () => {
    const facade = createWalletMiningRotationFacade();
    const runtime = { log: vi.fn() };

    await facade.retireAndReplace(runtime as never, options);

    expect(commandMocks.retireAndReplace).toHaveBeenCalledWith(runtime, options);
  });
});
