import { createRequire } from "node:module";
import type {
  FederationPaidContentSummarizeRunRequest,
  FederationPaidContentSummarizeRunResult,
} from "./federation-marketplace.js";

export const MARKETPLACE_SOL_SMOKE_FLAG = "FASED_MARKETPLACE_SOL_SMOKE";
const DEFAULT_MAX_SOL_AMOUNT = "0.01";
const DEFAULT_SOURCE_TEXT =
  "Fased Marketplace paid-task smoke: prove a tiny native SOL settlement can attach invoice, receipt, and settlement evidence to a content.summarize order.";
const SOL_DECIMALS = 9;
const require = createRequire(import.meta.url);
let solanaWeb3: typeof import("@solana/web3.js") | null = null;

export type MarketplaceSolPaymentSmokeConfig = {
  federationBaseUrl: string;
  maxAmountInput: string;
  request: FederationPaidContentSummarizeRunRequest;
};

type CliOptions = Record<string, string | true>;

type SmokeConfigInput = {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
};

function parseCliOptions(argv: readonly string[] = []): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) {
      continue;
    }
    const key = raw.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function isTruthySmokeValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readOption(params: {
  options: CliOptions;
  key: string;
  env: NodeJS.ProcessEnv;
  envName: string;
  fallback?: string;
}): string {
  const cliValue = params.options[params.key];
  if (typeof cliValue === "string" && cliValue.trim()) {
    return cliValue.trim();
  }
  const envValue = params.env[params.envName]?.trim();
  if (envValue) {
    return envValue;
  }
  return params.fallback?.trim() ?? "";
}

function requireOption(params: {
  options: CliOptions;
  key: string;
  env: NodeJS.ProcessEnv;
  envName: string;
  label: string;
}): string {
  const value = readOption(params).trim();
  if (!value) {
    throw new Error(`${params.label} is required (${params.envName} or --${params.key})`);
  }
  return value;
}

function decimalToUnits(amountInput: string): bigint {
  const normalized = amountInput.trim();
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) {
    throw new Error("amount must be a positive decimal number");
  }
  const [wholeRaw, fractionRaw = ""] = normalized.split(".");
  if (fractionRaw.length > SOL_DECIMALS) {
    throw new Error(`amount has too many decimal places for SOL`);
  }
  const units = BigInt(wholeRaw) * 10n ** BigInt(SOL_DECIMALS);
  const fraction = fractionRaw ? BigInt(fractionRaw.padEnd(SOL_DECIMALS, "0")) : 0n;
  const result = units + fraction;
  if (result <= 0n) {
    throw new Error("amount must be greater than zero");
  }
  return result;
}

function assertAmountWithinMax(params: { amountInput: string; maxAmountInput: string }) {
  const amount = decimalToUnits(params.amountInput);
  const max = decimalToUnits(params.maxAmountInput);
  if (amount > max) {
    throw new Error(
      `amount ${params.amountInput} exceeds smoke max ${params.maxAmountInput}; lower the amount or set FASED_MARKETPLACE_SOL_SMOKE_MAX_AMOUNT explicitly`,
    );
  }
}

function requireSolanaAddress(value: string, label: string): string {
  solanaWeb3 ??= require("@solana/web3.js") as typeof import("@solana/web3.js");
  try {
    if (new solanaWeb3.PublicKey(value).toBase58() === value) {
      return value;
    }
  } catch {
    // fall through to consistent validation error
  }
  throw new Error(`${label} must be a valid Solana address`);
}

export function loadMarketplaceSolPaymentSmokeConfig(
  input: SmokeConfigInput = {},
): MarketplaceSolPaymentSmokeConfig {
  const env = input.env ?? process.env;
  const options = parseCliOptions(input.argv);
  if (!isTruthySmokeValue(env[MARKETPLACE_SOL_SMOKE_FLAG]) && options.yes !== true) {
    throw new Error(
      `refusing to run live SOL payment smoke without ${MARKETPLACE_SOL_SMOKE_FLAG}=1 or --yes`,
    );
  }

  const federationBaseUrl = requireOption({
    options,
    key: "federation-url",
    env,
    envName: "FASED_FEDERATION_BASE_URL",
    label: "federation base URL",
  });
  const handle = requireOption({
    options,
    key: "handle",
    env,
    envName: "FASED_MARKETPLACE_SMOKE_SELLER_HANDLE",
    label: "seller handle",
  });
  const offerId = requireOption({
    options,
    key: "offer-id",
    env,
    envName: "FASED_MARKETPLACE_SMOKE_OFFER_ID",
    label: "offer id",
  });
  const amountInput = requireOption({
    options,
    key: "amount",
    env,
    envName: "FASED_MARKETPLACE_SMOKE_AMOUNT",
    label: "payment amount",
  });
  const payeeAddress = requireSolanaAddress(
    requireOption({
      options,
      key: "payee",
      env,
      envName: "FASED_MARKETPLACE_SMOKE_PAYEE",
      label: "seller payee address",
    }),
    "seller payee address",
  );
  const maxAmountInput = readOption({
    options,
    key: "max-amount",
    env,
    envName: "FASED_MARKETPLACE_SOL_SMOKE_MAX_AMOUNT",
    fallback: DEFAULT_MAX_SOL_AMOUNT,
  });
  assertAmountWithinMax({ amountInput, maxAmountInput });

  const sourceText = readOption({
    options,
    key: "source-text",
    env,
    envName: "FASED_MARKETPLACE_SMOKE_SOURCE_TEXT",
    fallback: DEFAULT_SOURCE_TEXT,
  });
  const style = readOption({
    options,
    key: "summary-style",
    env,
    envName: "FASED_MARKETPLACE_SMOKE_SUMMARY_STYLE",
    fallback: "bullets",
  });
  const maxSentencesRaw = readOption({
    options,
    key: "max-sentences",
    env,
    envName: "FASED_MARKETPLACE_SMOKE_MAX_SENTENCES",
    fallback: "2",
  });
  const maxSentences = Number(maxSentencesRaw);
  if (!Number.isSafeInteger(maxSentences) || maxSentences < 1 || maxSentences > 20) {
    throw new Error("max sentences must be an integer between 1 and 20");
  }

  return {
    federationBaseUrl,
    maxAmountInput,
    request: {
      handle,
      offerId,
      sourceText,
      summaryStyle: style === "plain" ? "plain" : "bullets",
      maxSentences,
      requestedOutput: "summary-v0",
      quote: {
        amountInput,
        assetDecimals: SOL_DECIMALS,
        currency: "SOL",
        chain: "solana",
        assetKind: "native",
        payeeAddress,
        expiresInMinutes: 5,
      },
    },
  };
}

export function formatMarketplaceSolPaymentSmokeResult(
  result: FederationPaidContentSummarizeRunResult,
): string {
  return JSON.stringify(
    {
      status: result.status,
      reason: result.reason,
      handle: result.handle,
      endpoint: result.endpoint,
      offerId: result.offerId,
      taskId: result.taskId,
      invoiceId: result.invoiceId,
      receiptId: result.receiptId,
      txRef: result.txRef,
      payerAddress: result.payerAddress,
      paymentProof: result.snapshot?.paymentProof,
      payment: result.snapshot?.output?.payment,
      summary: result.snapshot?.output?.result?.summaryText ?? result.snapshot?.output?.outputText,
    },
    null,
    2,
  );
}

export async function runMarketplaceSolPaymentSmoke(
  config: MarketplaceSolPaymentSmokeConfig,
): Promise<FederationPaidContentSummarizeRunResult> {
  process.env.FASED_FEDERATION_BASE_URL = config.federationBaseUrl;
  const { runPaidFederatedContentSummarize } = await import("./federation-marketplace.js");
  return await runPaidFederatedContentSummarize(config.request);
}
