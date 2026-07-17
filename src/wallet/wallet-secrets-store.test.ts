import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  deleteWalletProviderSecret,
  loadWalletProviderSecret,
  readWalletProviderSecretStatus,
  saveWalletProviderSecret,
} from "./wallet-secrets-store.js";

async function withTempStateDir(run: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "fased-wallet-secrets-test-"));
  const env: NodeJS.ProcessEnv = { ...process.env, FASED_STATE_DIR: tempDir };
  try {
    await run(env);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe("wallet provider secret store", () => {
  test("saves, loads, and reports alchemy credential status", async () => {
    await withTempStateDir(async (env) => {
      const saved = saveWalletProviderSecret(
        {
          providerId: "alchemy",
          credentials: {
            apiKey: "alchemy-key",
            serverSignerAccessKey: "signer-access",
            serverSignerAccountId: "acc-1",
          },
        },
        env,
      );
      expect(saved.providerId).toBe("alchemy");
      expect(saved.credentials.apiKey).toBe("alchemy-key");

      const loaded = loadWalletProviderSecret("alchemy", env);
      expect(loaded?.providerId).toBe("alchemy");
      expect(loaded?.credentials.serverSignerAccessKey).toBe("signer-access");

      const status = readWalletProviderSecretStatus("alchemy", env);
      expect(status.configured).toBe(true);
      expect(status.providerId).toBe("alchemy");
      expect(status.fields).toContain("apiKey");
      expect(status.fields).toContain("serverSignerAccessKey");
    });
  });

  test("delete removes provider secret file", async () => {
    await withTempStateDir(async (env) => {
      saveWalletProviderSecret(
        {
          providerId: "alchemy",
          credentials: {
            apiKey: "alchemy-key",
            serverSignerAccessKey: "signer-access",
          },
        },
        env,
      );
      const removed = deleteWalletProviderSecret("alchemy", env);
      expect(removed.removed).toBe(true);

      const statusAfterDelete = readWalletProviderSecretStatus("alchemy", env);
      expect(statusAfterDelete.configured).toBe(false);
      expect(statusAfterDelete.fields).toHaveLength(0);
    });
  });

  test("keeps Turnkey provider credentials available", async () => {
    await withTempStateDir(async (env) => {
      saveWalletProviderSecret(
        {
          providerId: "turnkey",
          credentials: {
            apiPublicKey: "public-key",
            apiPrivateKey: "provider-api-private-key",
            organizationId: "org-1",
            policyId: "policy-1",
          },
        },
        env,
      );

      expect(loadWalletProviderSecret("turnkey", env)).toMatchObject({
        providerId: "turnkey",
        credentials: {
          apiPublicKey: "public-key",
          organizationId: "org-1",
          policyId: "policy-1",
        },
      });
      expect(readWalletProviderSecretStatus("turnkey", env)).toMatchObject({
        configured: true,
        providerId: "turnkey",
      });
    });
  });

  test("never saves embedded wallet material or unavailable Privy credentials", async () => {
    await withTempStateDir(async (env) => {
      expect(() =>
        saveWalletProviderSecret(
          {
            providerId: "embedded-keystore",
            credentials: { legacyReference: "/must/not/be/read" },
          },
          env,
        ),
      ).toThrow(/no longer reads wallet private keys in Node.*import-legacy/i);
      expect(() =>
        saveWalletProviderSecret(
          {
            providerId: "privy",
            credentials: { appId: "must-not-be-saved" },
          },
          env,
        ),
      ).toThrow(/does not accept Gateway-held provider credentials/i);
      expect(() => loadWalletProviderSecret("embedded-keystore", env)).toThrow(/import-legacy/i);
      expect(readWalletProviderSecretStatus("embedded-keystore", env).configured).toBe(false);
      expect(readWalletProviderSecretStatus("privy", env).configured).toBe(false);
    });
  });
});
