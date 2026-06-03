import {
  formatMarketplaceSolPaymentSmokeResult,
  loadMarketplaceSolPaymentSmokeConfig,
  runMarketplaceSolPaymentSmoke,
} from "../gateway/marketplace-sol-payment-smoke.js";

async function main() {
  const config = loadMarketplaceSolPaymentSmokeConfig({
    argv: process.argv.slice(2),
  });

  console.log("== Marketplace SOL paid-task smoke ==");
  console.log(`Federation: ${config.federationBaseUrl}`);
  console.log(`Seller: ${config.request.handle}`);
  console.log(`Offer: ${config.request.offerId}`);
  console.log(`Payment: ${config.request.quote.amountInput} SOL`);
  console.log(`Payee: ${config.request.quote.payeeAddress}`);
  console.log(`Smoke max: ${config.maxAmountInput} SOL`);
  console.log();
  console.log("This will attempt a real Agent-wallet SOL transfer before calling tasks.create.");
  console.log();

  const result = await runMarketplaceSolPaymentSmoke(config);
  console.log(formatMarketplaceSolPaymentSmokeResult(result));

  if (result.status !== "accepted") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
