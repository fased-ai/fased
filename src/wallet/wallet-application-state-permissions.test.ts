import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  readWalletProviderRegistry,
  writeWalletProviderRegistry,
} from "./wallet-provider-registry.js";
import { ensureWalletStateDir } from "./wallet-runtime-config.js";

async function modes(stateDir: string): Promise<{ directory: number; registry: number }> {
  const walletDir = path.join(stateDir, "wallet");
  return {
    directory: (await fs.stat(walletDir)).mode & 0o7777,
    registry: (await fs.stat(path.join(walletDir, "provider-registry.v1.json"))).mode & 0o777,
  };
}

async function withServiceUmask(run: () => Promise<void>): Promise<void> {
  const previous = process.umask(0o007);
  try {
    await run();
  } finally {
    process.umask(previous);
  }
}

describe("wallet application state permissions", () => {
  it("keeps ordinary Local wallet application state owner-only", async () => {
    await withStateDirEnv("fased-wallet-state-local-", async ({ stateDir }) => {
      const env: NodeJS.ProcessEnv = { ...process.env, FASED_STATE_DIR: stateDir };
      delete env.FASED_HOST_PROFILE;
      delete env.FASED_PROTECTED_LOCAL;
      ensureWalletStateDir(env);
      writeWalletProviderRegistry(readWalletProviderRegistry(env), env);
      expect(await modes(stateDir)).toEqual({ directory: 0o700, registry: 0o600 });
    });
  });

  it.each([
    ["Protected Local", { FASED_HOST_PROFILE: "local", FASED_PROTECTED_LOCAL: "1" }],
    ["Hosting", { FASED_HOST_PROFILE: "hosting", FASED_PROTECTED_LOCAL: undefined }],
  ])(
    "keeps %s wallet application state within the restricted config group",
    async (_name, vars) => {
      await withStateDirEnv("fased-wallet-state-shared-", async ({ stateDir }) => {
        await withServiceUmask(async () => {
          const env = { ...process.env, FASED_STATE_DIR: stateDir, ...vars };
          await fs.chmod(stateDir, 0o2770);
          ensureWalletStateDir(env);
          writeWalletProviderRegistry(readWalletProviderRegistry(env), env);
          expect(await modes(stateDir)).toEqual({ directory: 0o2770, registry: 0o660 });
        });
      });
    },
  );

  it.each([
    ["Protected Local", { FASED_HOST_PROFILE: "local", FASED_PROTECTED_LOCAL: "1" }],
    ["Hosting", { FASED_HOST_PROFILE: "hosting", FASED_PROTECTED_LOCAL: undefined }],
  ])("repairs an existing owner-only wallet directory for %s", async (_name, vars) => {
    await withStateDirEnv("fased-wallet-state-repair-", async ({ stateDir }) => {
      const env = { ...process.env, FASED_STATE_DIR: stateDir, ...vars };
      const walletDir = path.join(stateDir, "wallet");
      await fs.mkdir(walletDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(walletDir, "provider-registry.v1.json"), "{}\n", {
        mode: 0o600,
      });

      ensureWalletStateDir(env);
      writeWalletProviderRegistry(readWalletProviderRegistry(env), env);

      expect(await modes(stateDir)).toEqual({ directory: 0o2770, registry: 0o660 });
    });
  });
});
