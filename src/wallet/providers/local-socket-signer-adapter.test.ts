import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireLocalSocketSignerPath } from "./local-socket-signer-adapter.js";

describe("requireLocalSocketSignerPath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns explicit signer socket when configured", () => {
    vi.stubEnv("FASED_WALLET_LOCAL_SIGNER_SOCKET", "/tmp/fased-wallet.sock");
    expect(requireLocalSocketSignerPath(process.env)).toBe("/tmp/fased-wallet.sock");
  });

  it("falls back to wallet state dir socket when env var is absent", () => {
    vi.stubEnv("FASED_STATE_DIR", "/tmp/fased-state");
    delete process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
    expect(requireLocalSocketSignerPath(process.env)).toBe(
      path.join("/tmp/fased-state", "wallet", "local-signer.sock"),
    );
  });
});
