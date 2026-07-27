import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { storeDeviceAuthToken } from "./device-auth-store.js";

async function withEnvironment(
  values: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function storedMode(stateDir: string): Promise<number> {
  return (await fs.stat(path.join(stateDir, "identity", "device-auth.json"))).mode & 0o777;
}

async function identityDirectoryMode(stateDir: string): Promise<number> {
  return (await fs.stat(path.join(stateDir, "identity"))).mode & 0o7777;
}

describe("device auth state permissions", () => {
  it("keeps ordinary Local device authentication owner-only", async () => {
    await withEnvironment(
      { FASED_HOST_PROFILE: undefined, FASED_PROTECTED_LOCAL: undefined },
      async () => {
        await withStateDirEnv("fased-device-auth-local-", async ({ stateDir }) => {
          storeDeviceAuthToken({
            deviceId: "local-device",
            role: "operator",
            token: "local-token",
          });
          expect(await storedMode(stateDir)).toBe(0o600);
          expect(await identityDirectoryMode(stateDir)).toBe(0o700);
        });
      },
    );
  });

  it.each([
    ["Protected Local", { FASED_HOST_PROFILE: "local", FASED_PROTECTED_LOCAL: "1" }],
    ["Hosting", { FASED_HOST_PROFILE: "hosting", FASED_PROTECTED_LOCAL: undefined }],
  ])("shares %s device authentication only with the service config group", async (_name, env) => {
    await withEnvironment(env, async () => {
      await withStateDirEnv("fased-device-auth-shared-", async ({ stateDir }) => {
        const filePath = path.join(stateDir, "identity", "device-auth.json");
        await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o2770 });
        await fs.chmod(path.dirname(filePath), 0o2770);
        storeDeviceAuthToken({
          deviceId: "shared-device",
          role: "operator",
          token: "operator-token",
        });
        expect(await storedMode(stateDir)).toBe(0o660);
        expect(await identityDirectoryMode(stateDir)).toBe(0o2770);

        await fs.chmod(filePath, 0o600);
        storeDeviceAuthToken({
          deviceId: "shared-device",
          role: "node",
          token: "node-token",
        });
        expect(await storedMode(stateDir)).toBe(0o660);
      });
    });
  });

  it.each([
    [
      "Protected Local",
      {
        FASED_HOST_PROFILE: "local",
        FASED_PROTECTED_LOCAL: "1",
        FASED_PROTECTED_LOCAL_INSTANCE: "0123456789abcdef",
        FASED_HOST_UPDATER_SOCKET: "/run/fased-local-controller/0123456789abcdef/request.sock",
      },
    ],
    [
      "Hosting",
      {
        FASED_HOST_PROFILE: "hosting",
        FASED_HOST_UPDATER_SOCKET: "/run/fased-host-updater/request.sock",
      },
    ],
  ])(
    "derives %s shared permissions from the managed config when launcher variables are absent",
    async (_name, vars) => {
      await withEnvironment(
        { FASED_HOST_PROFILE: undefined, FASED_PROTECTED_LOCAL: undefined },
        async () => {
          await withStateDirEnv("fased-device-auth-config-", async ({ stateDir }) => {
            await fs.writeFile(
              path.join(stateDir, "fased.json"),
              `${JSON.stringify({ env: { vars } })}\n`,
              { mode: 0o600 },
            );
            storeDeviceAuthToken({
              deviceId: "managed-device",
              role: "operator",
              token: "managed-token",
            });
            expect(await storedMode(stateDir)).toBe(0o660);
            expect(await identityDirectoryMode(stateDir)).toBe(0o2770);
          });
        },
      );
    },
  );

  it("does not broaden permissions for an incomplete managed profile", async () => {
    await withEnvironment(
      { FASED_HOST_PROFILE: undefined, FASED_PROTECTED_LOCAL: undefined },
      async () => {
        await withStateDirEnv("fased-device-auth-incomplete-", async ({ stateDir }) => {
          await fs.writeFile(
            path.join(stateDir, "fased.json"),
            `${JSON.stringify({
              env: {
                vars: {
                  FASED_HOST_PROFILE: "local",
                  FASED_PROTECTED_LOCAL: "1",
                  FASED_PROTECTED_LOCAL_INSTANCE: "0123456789abcdef",
                },
              },
            })}\n`,
            { mode: 0o600 },
          );
          storeDeviceAuthToken({
            deviceId: "incomplete-device",
            role: "operator",
            token: "incomplete-token",
          });
          expect(await storedMode(stateDir)).toBe(0o600);
          expect(await identityDirectoryMode(stateDir)).toBe(0o700);
        });
      },
    );
  });
});
