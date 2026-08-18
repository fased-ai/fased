import { describe, expect, it, vi } from "vitest";
import { createWalletRecoveryFacade } from "./wallet-recovery-facade.js";

const commandMocks = vi.hoisted(() => ({
  exportEncrypted: vi.fn(async () => undefined),
  restoreEncrypted: vi.fn(async () => undefined),
  exportRaw: vi.fn(async () => undefined),
}));

vi.mock("../commands/wallet.js", () => ({
  walletRecoveryExportCommand: commandMocks.exportEncrypted,
  walletRecoveryImportCommand: commandMocks.restoreEncrypted,
  walletRawExportCommand: commandMocks.exportRaw,
}));

describe("Wallet recovery facade", () => {
  it("routes encrypted export, restore, and raw export through one typed boundary", async () => {
    const exportEncrypted = vi.fn(async () => undefined);
    const restoreEncrypted = vi.fn(async () => undefined);
    const exportRaw = vi.fn(async () => undefined);
    const facade = createWalletRecoveryFacade({
      exportEncrypted,
      restoreEncrypted,
      exportRaw,
    });
    const runtime = { log: vi.fn() };
    const encryptedExport = { walletId: "primary", output: "/tmp/primary-recovery.json" };
    const encryptedRestore = {
      walletId: "restored",
      walletName: "Restored",
      role: "agent",
      recoveryFile: "/tmp/primary-recovery.json",
      rpcUrl: "https://rpc.example.test",
    };
    const rawExport = {
      walletId: "primary",
      output: "/tmp/primary-keypair.json",
      acknowledgeCustodyReduction: true,
    };

    await facade.exportEncrypted(runtime as never, encryptedExport);
    await facade.restoreEncrypted(runtime as never, encryptedRestore);
    await facade.exportRaw(runtime as never, rawExport);

    expect(exportEncrypted).toHaveBeenCalledWith(runtime, encryptedExport);
    expect(restoreEncrypted).toHaveBeenCalledWith(runtime, encryptedRestore);
    expect(exportRaw).toHaveBeenCalledWith(runtime, rawExport);
  });

  it("lazily forwards the default facade to the existing recovery commands", async () => {
    const facade = createWalletRecoveryFacade();
    const runtime = { log: vi.fn() };
    const encryptedExport = { walletId: "primary", output: "/tmp/primary-recovery.json" };
    const encryptedRestore = {
      walletId: "restored",
      role: "agent",
      recoveryFile: "/tmp/primary-recovery.json",
      rpcUrl: "https://rpc.example.test",
    };
    const rawExport = {
      walletId: "primary",
      output: "/tmp/primary-keypair.json",
      acknowledgeCustodyReduction: true,
    };

    await facade.exportEncrypted(runtime as never, encryptedExport);
    await facade.restoreEncrypted(runtime as never, encryptedRestore);
    await facade.exportRaw(runtime as never, rawExport);

    expect(commandMocks.exportEncrypted).toHaveBeenCalledWith(runtime, encryptedExport);
    expect(commandMocks.restoreEncrypted).toHaveBeenCalledWith(runtime, encryptedRestore);
    expect(commandMocks.exportRaw).toHaveBeenCalledWith(runtime, rawExport);
  });
});
