import { describe, expect, it } from "vitest";
import {
  loadMarketplaceSolPaymentSmokeConfig,
  MARKETPLACE_SOL_SMOKE_FLAG,
} from "./marketplace-sol-payment-smoke.js";

const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [MARKETPLACE_SOL_SMOKE_FLAG]: "1",
    FASED_FEDERATION_BASE_URL: "https://ff1.fased.app",
    FASED_MARKETPLACE_SMOKE_SELLER_HANDLE: "@seller@ff1.fased.app",
    FASED_MARKETPLACE_SMOKE_OFFER_ID: "https://seller.example/offers/content-summarize-v0",
    FASED_MARKETPLACE_SMOKE_AMOUNT: "0.001",
    FASED_MARKETPLACE_SMOKE_PAYEE: SYSTEM_PROGRAM_ADDRESS,
    ...overrides,
  };
}

describe("marketplace SOL payment smoke config", () => {
  it("refuses to run unless explicitly enabled", () => {
    expect(() =>
      loadMarketplaceSolPaymentSmokeConfig({
        env: baseEnv({ [MARKETPLACE_SOL_SMOKE_FLAG]: "" }),
      }),
    ).toThrow(/refusing to run live SOL payment smoke/u);
  });

  it("builds a native SOL quote for the paid content summarize path", () => {
    const config = loadMarketplaceSolPaymentSmokeConfig({ env: baseEnv() });

    expect(config.federationBaseUrl).toBe("https://ff1.fased.app");
    expect(config.request.handle).toBe("@seller@ff1.fased.app");
    expect(config.request.offerId).toBe("https://seller.example/offers/content-summarize-v0");
    expect(config.request.quote).toMatchObject({
      amountInput: "0.001",
      assetDecimals: 9,
      currency: "SOL",
      chain: "solana",
      assetKind: "native",
      payeeAddress: SYSTEM_PROGRAM_ADDRESS,
    });
    expect(config.request.quote).not.toHaveProperty("assetAddress");
  });

  it("rejects invalid Solana payee addresses before any payment can run", () => {
    expect(() =>
      loadMarketplaceSolPaymentSmokeConfig({
        env: baseEnv({ FASED_MARKETPLACE_SMOKE_PAYEE: "0xnot-solana" }),
      }),
    ).toThrow(/seller payee address must be a valid Solana address/u);
  });

  it("caps the live smoke amount unless the operator raises the max explicitly", () => {
    expect(() =>
      loadMarketplaceSolPaymentSmokeConfig({
        env: baseEnv({ FASED_MARKETPLACE_SMOKE_AMOUNT: "0.02" }),
      }),
    ).toThrow(/exceeds smoke max/u);

    const config = loadMarketplaceSolPaymentSmokeConfig({
      env: baseEnv({
        FASED_MARKETPLACE_SMOKE_AMOUNT: "0.02",
        FASED_MARKETPLACE_SOL_SMOKE_MAX_AMOUNT: "0.02",
      }),
    });
    expect(config.request.quote.amountInput).toBe("0.02");
  });

  it("allows CLI arguments to override smoke env fields", () => {
    const config = loadMarketplaceSolPaymentSmokeConfig({
      env: baseEnv({
        FASED_MARKETPLACE_SMOKE_AMOUNT: "0.001",
        FASED_MARKETPLACE_SOL_SMOKE_MAX_AMOUNT: "0.003",
      }),
      argv: ["--amount", "0.0025", "--summary-style", "plain", "--max-sentences", "3"],
    });

    expect(config.request.quote.amountInput).toBe("0.0025");
    expect(config.request.summaryStyle).toBe("plain");
    expect(config.request.maxSentences).toBe(3);
  });
});
