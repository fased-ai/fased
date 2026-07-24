import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { loadOrCreateDeviceIdentity } from "./device-identity.js";

describe("device identity state dir defaults", () => {
  it("writes the default identity file under FASED_STATE_DIR", async () => {
    await withStateDirEnv("fased-identity-state-", async ({ stateDir }) => {
      const identity = loadOrCreateDeviceIdentity();
      const identityPath = path.join(stateDir, "identity", "device.json");
      const raw = JSON.parse(await fs.readFile(identityPath, "utf8")) as { deviceId?: string };
      expect(raw.deviceId).toBe(identity.deviceId);
    });
  });

  it("keeps the Protected Local operator and Gateway identity group-readable", async () => {
    if (process.platform === "win32") {
      return;
    }
    const previous = process.env.FASED_PROTECTED_LOCAL;
    process.env.FASED_PROTECTED_LOCAL = "1";
    try {
      await withStateDirEnv("fased-protected-identity-state-", async ({ stateDir }) => {
        const identityPath = path.join(stateDir, "identity", "device.json");
        loadOrCreateDeviceIdentity();
        expect((await fs.stat(identityPath)).mode & 0o777).toBe(0o660);
        await fs.chmod(identityPath, 0o600);
        loadOrCreateDeviceIdentity();
        expect((await fs.stat(identityPath)).mode & 0o777).toBe(0o660);
      });
    } finally {
      if (previous === undefined) {
        delete process.env.FASED_PROTECTED_LOCAL;
      } else {
        process.env.FASED_PROTECTED_LOCAL = previous;
      }
    }
  });

  it("keeps the Hosting operator and Gateway identity group-readable", async () => {
    if (process.platform === "win32") {
      return;
    }
    const previous = process.env.FASED_HOST_PROFILE;
    process.env.FASED_HOST_PROFILE = "hosting";
    try {
      await withStateDirEnv("fased-hosting-identity-state-", async ({ stateDir }) => {
        const identityPath = path.join(stateDir, "identity", "device.json");
        loadOrCreateDeviceIdentity();
        expect((await fs.stat(identityPath)).mode & 0o777).toBe(0o660);
        await fs.chmod(identityPath, 0o600);
        loadOrCreateDeviceIdentity();
        expect((await fs.stat(identityPath)).mode & 0o777).toBe(0o660);
      });
    } finally {
      if (previous === undefined) {
        delete process.env.FASED_HOST_PROFILE;
      } else {
        process.env.FASED_HOST_PROFILE = previous;
      }
    }
  });
});
