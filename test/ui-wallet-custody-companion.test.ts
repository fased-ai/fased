import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteWalletCustodyCompanionDeviceShare,
  getWalletCustodyCompanionDeviceShareStatus,
  loadWalletCustodyCompanionDeviceShare,
  probeWalletCustodyCompanionHealth,
  saveWalletCustodyCompanionDeviceShare,
  walletCustodyCompanionSupportsSecureStorage,
} from "../ui/src/ui/wallet-custody-companion.ts";

describe("wallet-custody-companion", () => {
  beforeEach(() => {
    vi.stubGlobal("location", { origin: "https://agent.example" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("probes helper health successfully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          protocolVersion: 1,
          helper: "fased-macos-custody-companion",
          platform: "macos",
          storageMode: "os-keychain",
          availableRoutes: ["/v1/custody/health"],
          storedWalletCount: 1,
        }),
      })),
    );

    await expect(probeWalletCustodyCompanionHealth()).resolves.toEqual({
      ok: true,
      protocolVersion: 1,
      helper: "fased-macos-custody-companion",
      platform: "macos",
      storageMode: "os-keychain",
      availableRoutes: ["/v1/custody/health"],
      storedWalletCount: 1,
    });
  });

  it("checks native stored-share status", async () => {
    const resolveRequestUrl = (input: RequestInfo | URL): string =>
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(resolveRequestUrl(input)).toContain(
        "/v1/custody/device-share/status?gatewayOrigin=https%3A%2F%2Fagent.example&walletId=wallet-payment",
      );
      return {
        ok: true,
        json: async () => ({ ok: true, stored: true }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getWalletCustodyCompanionDeviceShareStatus(undefined, "wallet-payment"),
    ).resolves.toBe(true);
  });

  it("stores, loads, and deletes a native device share", async () => {
    const resolveRequestUrl = (input: RequestInfo | URL): string =>
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = resolveRequestUrl(input);
      if (String(init?.method ?? "GET").toUpperCase() === "POST") {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
          walletId?: string;
          deviceShare?: string;
        };
        if (url.endsWith("/v1/custody/device-share/store")) {
          expect(body.walletId).toBe("wallet-payment");
          expect(body.deviceShare).toBe("device-share-secret");
          return {
            ok: true,
            json: async () => ({ ok: true, stored: true, storageMode: "os-keychain" }),
          };
        }
        if (url.endsWith("/v1/custody/device-share/load")) {
          expect(body.walletId).toBe("wallet-payment");
          return {
            ok: true,
            json: async () => ({ ok: true, deviceShare: "device-share-secret" }),
          };
        }
        if (url.endsWith("/v1/custody/device-share/delete")) {
          expect(body.walletId).toBe("wallet-payment");
          return {
            ok: true,
            json: async () => ({ ok: true, removed: true }),
          };
        }
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      saveWalletCustodyCompanionDeviceShare({
        gatewayOrigin: undefined,
        walletId: "wallet-payment",
        deviceShare: "device-share-secret",
        credentialId: "cred-123",
        deviceLabel: "MacBook Pro",
      }),
    ).resolves.toBe(true);

    await expect(
      loadWalletCustodyCompanionDeviceShare({
        gatewayOrigin: undefined,
        walletId: "wallet-payment",
        prompt: "Unlock the device share.",
      }),
    ).resolves.toBe("device-share-secret");

    await expect(
      deleteWalletCustodyCompanionDeviceShare(undefined, "wallet-payment"),
    ).resolves.toBe(true);
  });

  it("requires full storage routes before the UI treats a helper as usable", () => {
    expect(
      walletCustodyCompanionSupportsSecureStorage({
        storageMode: "windows-dpapi",
        availableRoutes: [
          "/v1/custody/health",
          "/v1/custody/device-share/status",
          "/v1/custody/device-share/store",
          "/v1/custody/device-share/load",
          "/v1/custody/device-share/delete",
        ],
      }),
    ).toBe(true);

    expect(
      walletCustodyCompanionSupportsSecureStorage({
        storageMode: "unavailable",
        availableRoutes: ["/v1/custody/health"],
      }),
    ).toBe(false);
  });
});
