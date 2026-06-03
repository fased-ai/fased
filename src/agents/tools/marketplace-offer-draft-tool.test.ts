import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConfigCache } from "../../config/config.js";
import {
  createMarketplaceOfferDraftTool,
  createMarketplaceRequestDraftTool,
  createMarketplaceTool,
  createOffersTool,
} from "./marketplace-offer-draft-tool.js";

const previousEnv = {
  configPath: process.env.FASED_CONFIG_PATH,
  disableCache: process.env.FASED_DISABLE_CONFIG_CACHE,
  a2aName: process.env.FASED_A2A_NAME,
  federationBaseUrl: process.env.FASED_FEDERATION_BASE_URL,
  stateDir: process.env.FASED_STATE_DIR,
};

let tempDir: string | null = null;

async function setupTempConfig(config: unknown = {}, opts: { agentWallet?: boolean } = {}) {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "fased-offer-draft-tool-"));
  const configPath = path.join(tempDir, "fased.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  process.env.FASED_CONFIG_PATH = configPath;
  process.env.FASED_DISABLE_CONFIG_CACHE = "1";
  process.env.FASED_A2A_NAME = "test-agent";
  process.env.FASED_FEDERATION_BASE_URL = "https://ff1.fased.app";
  process.env.FASED_STATE_DIR = tempDir;
  if (opts.agentWallet !== false) {
    const walletDir = path.join(tempDir, "wallet");
    await mkdir(walletDir, { recursive: true });
    await writeFile(
      path.join(walletDir, "provider-registry.v1.json"),
      JSON.stringify(
        {
          version: 1,
          providers: {
            "embedded-keystore": {
              enabled: true,
              label: "Self-hosted",
              updatedAt: "2026-05-02T00:00:00.000Z",
            },
            "local-socket-signer": {
              enabled: true,
              label: "Local signer",
              updatedAt: "2026-05-02T00:00:00.000Z",
            },
            alchemy: { enabled: false, updatedAt: "2026-05-02T00:00:00.000Z" },
            turnkey: { enabled: false, updatedAt: "2026-05-02T00:00:00.000Z" },
            privy: { enabled: false, updatedAt: "2026-05-02T00:00:00.000Z" },
          },
          wallets: [
            {
              id: "wallet-agent",
              name: "Agent",
              providerId: "local-socket-signer",
              addresses: { solana: "AgentSeller111111111111111111111111111111111" },
              metadata: { purpose: "agent" },
              createdAt: "2026-05-02T00:00:00.000Z",
              updatedAt: "2026-05-02T00:00:00.000Z",
            },
          ],
          assignments: {},
          defaultWalletId: "wallet-agent",
          updatedAt: "2026-05-02T00:00:00.000Z",
        },
        null,
        2,
      ),
      "utf-8",
    );
  }
  clearConfigCache();
  return configPath;
}

async function readPersistedConfig(configPath: string) {
  clearConfigCache();
  return JSON.parse(await readFile(configPath, "utf-8")) as {
    federation?: {
      offers?: {
        manual?: Array<{
          enabled?: boolean;
          title?: string;
          serviceKind?: string;
          summary?: string;
          inputShape?: string;
          deliveryShape?: string;
          capabilities?: string[];
          pricing?: {
            currency?: string;
            model?: string;
            amount?: number;
            unit?: string;
            unitLabel?: string;
          };
          fulfillmentMode?: string;
          performer?: string;
          receiptRules?: Array<{ kind?: string; required?: boolean; description?: string }>;
          paymentRails?: string[];
          acceptedAssets?: string[];
          paymentDefaults?: { payee?: { address?: string } };
        }>;
      };
      marketplace?: {
        requests?: {
          manual?: Array<{
            enabled?: boolean;
            source?: string;
            status?: string;
            title?: string;
            serviceKind?: string;
            summary?: string;
            pricing?: {
              currency?: string;
              model?: string;
              amount?: number;
              unit?: string;
              unitLabel?: string;
            };
            fulfillmentMode?: string;
            receiptRules?: Array<{ kind?: string; required?: boolean; description?: string }>;
            paymentRails?: string[];
            acceptedAssets?: string[];
          }>;
        };
      };
    };
  };
}

afterEach(async () => {
  if (previousEnv.configPath === undefined) {
    delete process.env.FASED_CONFIG_PATH;
  } else {
    process.env.FASED_CONFIG_PATH = previousEnv.configPath;
  }
  if (previousEnv.disableCache === undefined) {
    delete process.env.FASED_DISABLE_CONFIG_CACHE;
  } else {
    process.env.FASED_DISABLE_CONFIG_CACHE = previousEnv.disableCache;
  }
  if (previousEnv.a2aName === undefined) {
    delete process.env.FASED_A2A_NAME;
  } else {
    process.env.FASED_A2A_NAME = previousEnv.a2aName;
  }
  if (previousEnv.federationBaseUrl === undefined) {
    delete process.env.FASED_FEDERATION_BASE_URL;
  } else {
    process.env.FASED_FEDERATION_BASE_URL = previousEnv.federationBaseUrl;
  }
  if (previousEnv.stateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousEnv.stateDir;
  }
  clearConfigCache();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

beforeEach(() => {
  tempDir = null;
});

describe("marketplace_offer_draft tool", () => {
  it("is owner-only because it writes local offer config", () => {
    expect(createMarketplaceOfferDraftTool().ownerOnly).toBe(true);
  });

  it("rejects chat-created drafts until an Agent wallet exists", async () => {
    await setupTempConfig({}, { agentWallet: false });
    const tool = createMarketplaceOfferDraftTool();

    const result = await tool.execute("offer-draft-no-wallet", {
      title: "Daily content summary",
    });

    expect(result.details).toMatchObject({
      ok: false,
      status: "agent_wallet_required",
      reviewRequired: true,
    });
  });

  it("creates a disabled local Marketplace draft from chat inputs", async () => {
    const configPath = await setupTempConfig({});
    const tool = createMarketplaceOfferDraftTool();

    const result = await tool.execute("offer-draft-1", {
      title: "Daily content summary",
      summary: "Summarize long research notes into concise buyer-ready bullets.",
      inputShape: "source-text",
      deliveryShape: "summary-v0",
      capabilities: ["summarize", "research"],
      priceCurrency: "SOL",
      priceAmount: 0.01,
      priceUnit: "per-job",
      fulfillmentMode: "agent",
      receiptRules: [{ kind: "artifact", required: true, description: "summary file" }],
    });

    expect(result.details).toMatchObject({
      ok: true,
      status: "draft_created",
      reviewRequired: true,
      publishState: "disabled_until_review",
      title: "Daily content summary",
      serviceKind: "content.summarize",
    });

    const persisted = await readPersistedConfig(configPath);
    expect(persisted.federation?.offers?.manual).toHaveLength(1);
    expect(persisted.federation?.offers?.manual?.[0]).toMatchObject({
      enabled: false,
      title: "Daily content summary",
      serviceKind: "content.summarize",
      summary: "Summarize long research notes into concise buyer-ready bullets.",
      capabilities: ["summarize", "research"],
      pricing: {
        currency: "SOL",
        model: "quote",
        amount: 0.01,
        unit: "per-job",
      },
      fulfillmentMode: "agent",
      performer: "agent",
      receiptRules: [{ kind: "artifact", required: true, description: "summary file" }],
      paymentDefaults: {
        payee: { address: "AgentSeller111111111111111111111111111111111" },
      },
    });
  });

  it("preserves existing manual offers and allocates a new draft id", async () => {
    const configPath = await setupTempConfig({
      federation: {
        offers: {
          manual: [
            {
              id: "existing-offer",
              source: "manual",
              enabled: true,
              title: "Existing Offer",
              serviceKind: "task.general",
            },
          ],
        },
      },
    });
    const tool = createMarketplaceOfferDraftTool();

    await tool.execute("offer-draft-2", {
      title: "Code review package",
      summary: "Review a pull request and return risk notes.",
    });

    const persisted = await readPersistedConfig(configPath);
    expect(persisted.federation?.offers?.manual?.map((entry) => entry.title)).toEqual([
      "Existing Offer",
      "Code review package",
    ]);
    expect(persisted.federation?.offers?.manual?.[1]).toMatchObject({
      enabled: false,
      serviceKind: "code.review",
    });
  });

  it("infers richer marketplace service kinds and default terms", async () => {
    const configPath = await setupTempConfig({});
    const tool = createMarketplaceOfferDraftTool();

    await tool.execute("offer-draft-data-lookup", {
      title: "Data lookup API",
      summary: "Look up inventory records and return verified data.",
    });

    const persisted = await readPersistedConfig(configPath);
    expect(persisted.federation?.offers?.manual?.[0]).toMatchObject({
      enabled: false,
      serviceKind: "data.lookup",
      inputShape: "lookup-query",
      deliveryShape: "lookup-result",
      capabilities: ["lookup", "data", "verification"],
      pricing: {
        currency: "USDC",
        model: "quote",
        unit: "per-job",
      },
      paymentRails: ["USDC", "SOL", "SAT", "FCOD"],
      acceptedAssets: ["USDC", "SOL", "SAT", "FCOD"],
    });
  });

  it("exposes an @offers alias for chat Marketplace search and paid invoices", async () => {
    await setupTempConfig({
      federation: {
        offers: {
          manual: [
            {
              id: "content-summary-offer",
              enabled: true,
              title: "Content Summary",
              summary: "Summarize documents and posts.",
              serviceKind: "content.summarize",
            },
          ],
        },
        marketplace: {
          orders: {
            local: [
              {
                id: "summary-paid-1",
                status: "delivered",
                title: "Content Summary",
                serviceKind: "content.summarize",
                invoiceId: "invoice-summary-1",
                receiptId: "receipt-summary-1",
                txRef: "tx-summary-1",
                paymentIntent: { status: "verified" },
              },
            ],
          },
        },
      },
    });
    const tool = createOffersTool();

    const search = await tool.execute("offers-search", {
      action: "search",
      query: "content summary",
      includeRemote: false,
    });
    expect(search.details).toMatchObject({
      ok: true,
      offers: [
        expect.objectContaining({
          configId: "content-summary-offer",
        }),
      ],
    });

    const invoices = await tool.execute("offers-paid", {
      action: "paid_invoices",
      query: "content",
    });
    expect(invoices.details).toMatchObject({
      ok: true,
      orders: [
        expect.objectContaining({
          configId: "summary-paid-1",
        }),
      ],
    });
  });
});

describe("marketplace_request_draft tool", () => {
  it("is owner-only because it writes local request config", () => {
    expect(createMarketplaceRequestDraftTool().ownerOnly).toBe(true);
  });

  it("rejects buyer request drafts until an Agent wallet exists", async () => {
    await setupTempConfig({}, { agentWallet: false });
    const tool = createMarketplaceRequestDraftTool();

    const result = await tool.execute("request-draft-no-wallet", {
      title: "Need a support triage agent",
    });

    expect(result.details).toMatchObject({
      ok: false,
      status: "agent_wallet_required",
      reviewRequired: true,
    });
  });

  it("creates a disabled Marketplace request draft from chat inputs", async () => {
    const configPath = await setupTempConfig({});
    const tool = createMarketplaceRequestDraftTool();

    const result = await tool.execute("request-draft-1", {
      title: "Need daily data lookup",
      summary: "Find ten verified supplier records every weekday.",
      budgetCurrency: "USDC",
      budgetAmount: 25,
      priceUnit: "per-day",
      fulfillmentMode: "agent-approval",
      receiptRules: [{ kind: "result", required: true, description: "CSV result summary" }],
    });

    expect(result.details).toMatchObject({
      ok: true,
      status: "draft_created",
      reviewRequired: true,
      publishState: "disabled_until_review",
      title: "Need daily data lookup",
      serviceKind: "data.lookup",
    });

    const persisted = await readPersistedConfig(configPath);
    expect(persisted.federation?.marketplace?.requests?.manual).toHaveLength(1);
    expect(persisted.federation?.marketplace?.requests?.manual?.[0]).toMatchObject({
      enabled: false,
      source: "chat",
      status: "draft",
      title: "Need daily data lookup",
      serviceKind: "data.lookup",
      summary: "Find ten verified supplier records every weekday.",
      pricing: {
        currency: "USDC",
        model: "quote",
        amount: 25,
        unit: "per-day",
      },
      fulfillmentMode: "agent-approval",
      receiptRules: [{ kind: "result", required: true, description: "CSV result summary" }],
      paymentRails: ["USDC", "SOL", "SAT", "FCOD"],
      acceptedAssets: ["USDC", "SOL", "SAT", "FCOD"],
    });
  });
});

describe("marketplace tool", () => {
  it("searches local offers and paid invoice/order records from chat", async () => {
    await setupTempConfig({
      federation: {
        offers: {
          manual: [
            {
              id: "twitter-api-offer",
              enabled: true,
              title: "Twitter API lookup",
              serviceKind: "api.access",
              summary: "Paid API access for social search.",
              capabilities: ["api", "twitter"],
              acceptedAssets: ["SOL"],
              paymentDefaults: {
                currency: "SOL",
                chain: "solana",
                assetDecimals: 9,
                asset: { kind: "native" },
                payee: { chain: "solana", address: "AgentSeller111111111111111111111111111111111" },
              },
            },
          ],
        },
        marketplace: {
          orders: {
            local: [
              {
                id: "checkout-paid-1",
                status: "delivered",
                title: "Twitter API lookup",
                serviceKind: "api.access",
                invoiceId: "invoice-1",
                receiptId: "receipt-1",
                txRef: "tx-1",
                paymentIntent: { status: "verified" },
                settlement: { status: "settled" },
              },
            ],
          },
        },
      },
    });
    const tool = createMarketplaceTool();

    const search = await tool.execute("market-search", {
      action: "search",
      query: "twitter",
    });
    expect(search.details).toMatchObject({
      ok: true,
      offers: [
        expect.objectContaining({
          configId: "twitter-api-offer",
        }),
      ],
    });

    const invoices = await tool.execute("market-paid", {
      action: "paid_invoices",
      query: "twitter",
    });
    expect(invoices.details).toMatchObject({
      ok: true,
      orders: [
        expect.objectContaining({
          configId: "checkout-paid-1",
          order: expect.objectContaining({
            invoiceId: "invoice-1",
            receiptId: "receipt-1",
            txRef: "tx-1",
          }),
        }),
      ],
    });
  });
});
