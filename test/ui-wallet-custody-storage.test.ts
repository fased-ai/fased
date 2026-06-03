import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredWalletCustodyDeviceShare,
  decryptStoredWalletCustodyDeviceShare,
  getStoredWalletCustodyDeviceShareCredentialId,
  hasStoredWalletCustodyDeviceShare,
  loadStoredWalletCustodyDeviceShare,
  saveStoredWalletCustodyDeviceShare,
} from "../ui/src/ui/wallet-custody-storage.ts";

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

  get length() {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function randomBase64Url(bytes = 32): string {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(raw).toString("base64url");
}

describe("wallet-custody-storage", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores encrypted device shares and decrypts them with the derived key", async () => {
    const storageKeyBase64 = randomBase64Url(32);
    await saveStoredWalletCustodyDeviceShare({
      gatewayUrl: "https://agent.example",
      walletId: "wallet-payment",
      deviceShare: "device-share-secret",
      storageKeyBase64,
      credentialId: "cred-123",
    });

    expect(hasStoredWalletCustodyDeviceShare("https://agent.example", "wallet-payment")).toBe(true);
    expect(loadStoredWalletCustodyDeviceShare("https://agent.example", "wallet-payment")).toBe("");
    expect(
      getStoredWalletCustodyDeviceShareCredentialId("https://agent.example", "wallet-payment"),
    ).toBe("cred-123");
    await expect(
      decryptStoredWalletCustodyDeviceShare({
        gatewayUrl: "https://agent.example",
        walletId: "wallet-payment",
        storageKeyBase64,
      }),
    ).resolves.toBe("device-share-secret");

    clearStoredWalletCustodyDeviceShare("https://agent.example", "wallet-payment");
    expect(hasStoredWalletCustodyDeviceShare("https://agent.example", "wallet-payment")).toBe(
      false,
    );
  });
});
