import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEDERATION_BASE_URL,
  normalizeHandle,
  resolveAgentPublicOrigin,
  resolveFederationBaseUrl,
  resolveFederationBondWalletId,
  resolveFederationHandle,
} from "./runtime.js";

describe("federation runtime defaults", () => {
  it("uses ff1 federation base URL by default", () => {
    expect(resolveFederationBaseUrl({})).toBe(DEFAULT_FEDERATION_BASE_URL);
  });

  it("normalizes shorthand handles with fallback domain", () => {
    expect(normalizeHandle("fased-agent", "ff1.fased.app")).toBe("@fased-agent@ff1.fased.app");
  });

  it("derives a deterministic hosted handle when explicit handle is missing", () => {
    const handle = resolveFederationHandle({
      env: {
        FASED_A2A_NAME: "worker",
      },
      fallbackDomain: "ff1.fased.app",
      nodeId: "0123456789abcdef0123456789abcdef",
    });
    expect(handle).toBe("@worker-0123456789ab@ff1.fased.app");
  });

  it("uses the saved federation handle alias from onboarding", () => {
    const handle = resolveFederationHandle({
      env: {
        FASED_FEDERATION_HANDLE: "@agent@ff1.fased.app",
      },
      fallbackDomain: "ff1.fased.app",
      nodeId: "0123456789abcdef0123456789abcdef",
    });
    expect(handle).toBe("@agent@ff1.fased.app");
  });

  it("uses explicit public origin when configured", () => {
    const origin = resolveAgentPublicOrigin({
      FASED_A2A_ORIGIN: "https://node42.example.com",
    });
    expect(origin).toBe("https://node42.example.com");
  });

  it("uses the configured federation bond Vault and does not fall back to SAT mining", () => {
    const walletId = resolveFederationBondWalletId({
      env: {},
      cfg: {
        federation: {
          bond: {
            walletId: "bond-wallet",
          },
        },
        plugins: {
          entries: {
            "sat-mining": {
              enabled: true,
              config: {
                walletId: "mining-wallet",
              },
            },
          },
        },
      },
    });
    expect(walletId).toBe("bond-wallet");
    expect(
      resolveFederationBondWalletId({
        env: {},
        cfg: {
          plugins: {
            entries: {
              "sat-mining": {
                enabled: true,
                config: {
                  walletId: "mining-wallet",
                },
              },
            },
          },
        },
      }),
    ).toBe("");
  });
});
