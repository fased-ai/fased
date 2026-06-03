import { describe, expect, it } from "vitest";
import {
  loadMarketplaceUsdcSplPaymentSmokeConfig,
  MARKETPLACE_USDC_SPL_SMOKE_FLAG,
} from "./marketplace-usdc-spl-payment-smoke.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [MARKETPLACE_USDC_SPL_SMOKE_FLAG]: "1",
    FASED_FEDERATION_BASE_URL: "https://ff1.fased.app",
    FASED_MARKETPLACE_SMOKE_SELLER_HANDLE: "@seller@ff1.fased.app",
    FASED_MARKETPLACE_SMOKE_OFFER_ID: "https://seller.example/offers/content-summarize-v0",
    FASED_MARKETPLACE_SMOKE_AMOUNT: "0.01",
    FASED_MARKETPLACE_SMOKE_USDC_MINT: USDC_MINT,
    FASED_MARKETPLACE_SMOKE_PAYEE: SYSTEM_PROGRAM_ADDRESS,
    ...overrides,
  };
}

describe("marketplace USDC/SPL payment smoke config", () => {
  it("refuses to run unless explicitly enabled", () => {
    expect(() =>
      loadMarketplaceUsdcSplPaymentSmokeConfig({
        env: baseEnv({ [MARKETPLACE_USDC_SPL_SMOKE_FLAG]: "" }),
      }),
    ).toThrow(/refusing to run live SPL payment smoke/u);
  });

  it("builds a Solana SPL quote for the paid content summarize path", () => {
    const config = loadMarketplaceUsdcSplPaymentSmokeConfig({ env: baseEnv() });

    expect(config.federationBaseUrl).toBe("https://ff1.fased.app");
    expect(config.request.handle).toBe("@seller@ff1.fased.app");
    expect(config.request.offerId).toBe("https://seller.example/offers/content-summarize-v0");
    expect(config.request.quote).toMatchObject({
      amountInput: "0.01",
      assetDecimals: 6,
      currency: "USDC",
      chain: "solana",
      assetKind: "spl-token",
      assetAddress: USDC_MINT,
      payeeAddress: SYSTEM_PROGRAM_ADDRESS,
    });
  });

  it("rejects invalid Solana mint and payee addresses before any payment can run", () => {
    expect(() =>
      loadMarketplaceUsdcSplPaymentSmokeConfig({
        env: baseEnv({ FASED_MARKETPLACE_SMOKE_USDC_MINT: "0xnot-solana" }),
      }),
    ).toThrow(/SPL mint must be a valid Solana address/u);

    expect(() =>
      loadMarketplaceUsdcSplPaymentSmokeConfig({
        env: baseEnv({ FASED_MARKETPLACE_SMOKE_PAYEE: "not-a-wallet" }),
      }),
    ).toThrow(/seller payee address must be a valid Solana address/u);
  });

  it("caps the live smoke amount unless the operator raises the max explicitly", () => {
    expect(() =>
      loadMarketplaceUsdcSplPaymentSmokeConfig({
        env: baseEnv({ FASED_MARKETPLACE_SMOKE_AMOUNT: "2" }),
      }),
    ).toThrow(/exceeds smoke max/u);

    const config = loadMarketplaceUsdcSplPaymentSmokeConfig({
      env: baseEnv({
        FASED_MARKETPLACE_SMOKE_AMOUNT: "2",
        FASED_MARKETPLACE_SMOKE_MAX_AMOUNT: "2",
      }),
    });
    expect(config.request.quote.amountInput).toBe("2");
  });

  it("allows CLI arguments to override smoke env fields", () => {
    const config = loadMarketplaceUsdcSplPaymentSmokeConfig({
      env: baseEnv({
        FASED_MARKETPLACE_SMOKE_AMOUNT: "0.02",
        FASED_MARKETPLACE_SMOKE_MAX_AMOUNT: "0.03",
      }),
      argv: ["--amount", "0.025", "--summary-style", "plain", "--max-sentences", "3"],
    });

    expect(config.request.quote.amountInput).toBe("0.025");
    expect(config.request.summaryStyle).toBe("plain");
    expect(config.request.maxSentences).toBe(3);
  });
});
