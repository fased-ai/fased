import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  walletKeystoreExportCommand,
  walletKeystoreImportCommand,
  walletKeystoreInitCommand,
  walletKeystorePassphraseInitCommand,
  walletKeystorePassphraseRotateCommand,
  walletKeystoreStatusCommand,
  walletKeystoreValidateCommand,
} from "./wallet.js";

vi.mock("../wallet/providers/turnkey-adapter.js", () => ({
  TurnkeyAdapter: class {
    readonly id = "turnkey";
  },
}));

describe("retired Node keystore CLI boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails every legacy command with native one-way migration guidance before material access", async () => {
    const readFileSync = vi.spyOn(fs, "readFileSync");
    const writeFileSync = vi.spyOn(fs, "writeFileSync");
    const runtime = { log: vi.fn() } as never;
    const commands = [
      () => walletKeystoreInitCommand(runtime, { chain: "solana", walletId: "legacy" }),
      () => walletKeystoreImportCommand(runtime, { chain: "solana", walletId: "legacy" }),
      () => walletKeystoreStatusCommand(runtime, { chain: "solana", walletId: "legacy" }),
      () => walletKeystoreValidateCommand(runtime, { chain: "solana", walletId: "legacy" }),
      () => walletKeystorePassphraseInitCommand(runtime),
      () => walletKeystorePassphraseRotateCommand(runtime),
      () => walletKeystoreExportCommand(runtime),
    ];

    for (const run of commands) {
      await expect(run()).rejects.toThrow(/no longer reads wallet private keys in Node/i);
      await expect(run()).rejects.toThrow(/fased-signerd admin wallet import-legacy/i);
    }

    expect(readFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
