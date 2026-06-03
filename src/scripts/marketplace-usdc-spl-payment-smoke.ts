import {
  formatMarketplaceUsdcSplPaymentSmokeResult,
  loadMarketplaceUsdcSplPaymentSmokeConfig,
  runMarketplaceUsdcSplPaymentSmoke,
} from "../gateway/marketplace-usdc-spl-payment-smoke.js";

async function main() {
  const config = loadMarketplaceUsdcSplPaymentSmokeConfig({
    argv: process.argv.slice(2),
  });

  console.log("== Marketplace USDC/SPL paid A2A smoke ==");
  console.log(`Federation: ${config.federationBaseUrl}`);
  console.log(`Seller: ${config.request.handle}`);
  console.log(`Offer: ${config.request.offerId}`);
  console.log(
    `Payment: ${config.request.quote.amountInput} ${config.request.quote.currency} (${config.request.quote.assetAddress})`,
  );
  console.log(`Payee: ${config.request.quote.payeeAddress}`);
  console.log(`Smoke max: ${config.maxAmountInput} ${config.request.quote.currency}`);
  console.log();
  console.log("This will attempt a real Agent-wallet SPL transfer before calling tasks.create.");
  console.log();

  const result = await runMarketplaceUsdcSplPaymentSmoke(config);
  console.log(formatMarketplaceUsdcSplPaymentSmokeResult(result));

  if (result.status !== "accepted") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
