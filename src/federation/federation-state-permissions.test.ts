import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { persistFederationAccessToken } from "./access-token.js";
import { ensureFederationStateDirectory } from "./federation-state-permissions.js";

const token = {
  tokenId: "fixture-token",
  nodeId: "fixture-node",
  handle: "@fixture@fased.test",
  issuedAt: "2026-07-26T00:00:00.000Z",
  expiresAt: "2027-07-26T00:00:00.000Z",
  scopes: ["federation.read"],
  signature: "fixture-signature",
};

async function modes(stateDir: string): Promise<{ directory: number; token: number }> {
  const federationDir = path.join(stateDir, "federation");
  return {
    directory: (await fs.stat(federationDir)).mode & 0o7777,
    token: (await fs.stat(path.join(federationDir, "access-token.json"))).mode & 0o777,
  };
}

async function withServiceUmask(run: () => Promise<void>): Promise<void> {
  const previous = process.umask(0o027);
  try {
    await run();
  } finally {
    process.umask(previous);
  }
}

describe("federation application state permissions", () => {
  it("keeps ordinary Local federation credentials owner-only", async () => {
    await withStateDirEnv("fased-federation-state-local-", async ({ stateDir }) => {
      const env: NodeJS.ProcessEnv = { ...process.env, FASED_STATE_DIR: stateDir };
      delete env.FASED_HOST_PROFILE;
      delete env.FASED_PROTECTED_LOCAL;
      await persistFederationAccessToken(token, env);
      expect(await modes(stateDir)).toEqual({ directory: 0o700, token: 0o600 });
    });
  });

  it.each([
    ["Protected Local", { FASED_HOST_PROFILE: "local", FASED_PROTECTED_LOCAL: "1" }],
    ["Hosting", { FASED_HOST_PROFILE: "hosting", FASED_PROTECTED_LOCAL: undefined }],
  ])("shares %s federation credentials only with the service config group", async (_name, vars) => {
    await withStateDirEnv("fased-federation-state-shared-", async ({ stateDir }) => {
      await withServiceUmask(async () => {
        const env = { ...process.env, FASED_STATE_DIR: stateDir, ...vars };
        const federationDir = path.join(stateDir, "federation");
        await fs.chmod(stateDir, 0o2770);
        await persistFederationAccessToken(token, env);
        expect(await modes(stateDir)).toEqual({ directory: 0o2770, token: 0o660 });

        await fs.chmod(path.join(federationDir, "access-token.json"), 0o600);
        await persistFederationAccessToken({ ...token, hostedState: "ready" }, env);
        expect(await modes(stateDir)).toEqual({ directory: 0o2770, token: 0o660 });
      });
    });
  });

  it("does not rewrite an existing shared directory owned by a peer service", async () => {
    await withStateDirEnv("fased-federation-state-peer-", async ({ stateDir }) => {
      const directory = path.join(stateDir, "federation");
      await fs.mkdir(directory, { mode: 0o750 });
      await fs.chmod(directory, 0o2750);

      await ensureFederationStateDirectory(directory, {
        ...process.env,
        FASED_STATE_DIR: stateDir,
        FASED_PROTECTED_LOCAL: "1",
      });

      expect((await fs.stat(directory)).mode & 0o7777).toBe(0o2750);
    });
  });
});
