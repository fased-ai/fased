import { Transaction } from "@solana/web3.js";
import { defaultSolanaAccountAtIndex, Turnkey, type TurnkeyApiClient } from "@turnkey/sdk-server";
import { TurnkeySigner } from "@turnkey/solana";
import type { WalletChain } from "../../config/types.wallet.js";
import { fetchSolanaRpc } from "../solana-assets.js";
import {
  executeTurnkeyReviewedTransaction,
  prepareTurnkeyReviewedTransaction,
} from "../turnkey-reviewed-state.js";
import {
  WalletProviderError,
  type WalletProviderAdapter,
  type WalletProviderAddressMap,
  type WalletProviderBalanceResult,
  type WalletProviderCreateWalletResult,
  type WalletProviderHealth,
  type WalletProviderPrepareTxRequest,
  type WalletProviderPrepareTxResult,
  type WalletProviderSendTxRequest,
  type WalletProviderSendTxResult,
} from "../wallet-provider-adapter.js";
import { walletDiagnosticErrorMessage } from "../wallet-redaction.js";

const DEFAULT_TURNKEY_API_BASE_URL = "https://api.turnkey.com";

export type TurnkeyAdapterCredentials = {
  apiPublicKey: string;
  apiPrivateKey: string;
  organizationId?: string;
  policyId?: string;
  baseUrl?: string;
  rpcUrl?: string;
  defaultSolanaAddress?: string;
  providerWalletId?: string;
};

export type TurnkeyAdapterOptions = {
  chains: WalletChain[];
  credentials: TurnkeyAdapterCredentials;
  service: {
    host: string;
    port: number;
  };
  walletName?: string;
  stateEnv?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  dependencies?: {
    createClient?: () => TurnkeyApiClient;
    signTransaction?: (params: {
      client: TurnkeyApiClient;
      organizationId: string;
      transaction: Transaction;
      signerAddress: string;
    }) => Promise<Transaction>;
  };
};

function clean(value: string | undefined): string {
  return String(value ?? "").trim();
}

function asProviderError(error: unknown, action: string): WalletProviderError {
  if (error instanceof WalletProviderError) {
    return error;
  }
  return new WalletProviderError({
    code: "wallet_provider_unavailable",
    message: `Turnkey ${action} failed: ${walletDiagnosticErrorMessage(error)}`,
    retryable: false,
    cause: error,
  });
}

export class TurnkeyAdapter implements WalletProviderAdapter {
  readonly id = "turnkey" as const;
  readonly displayName = "Turnkey Wallet";
  readonly capabilities: WalletProviderAdapter["capabilities"];

  private readonly credentials: Required<
    Pick<TurnkeyAdapterCredentials, "apiPublicKey" | "apiPrivateKey">
  > &
    Omit<TurnkeyAdapterCredentials, "apiPublicKey" | "apiPrivateKey">;
  private readonly walletName: string;
  private readonly stateEnv: NodeJS.ProcessEnv;
  private readonly dependencies: NonNullable<TurnkeyAdapterOptions["dependencies"]>;
  private clientPromise: Promise<TurnkeyApiClient> | null = null;

  constructor(options: TurnkeyAdapterOptions) {
    this.credentials = {
      apiPublicKey: clean(options.credentials.apiPublicKey),
      apiPrivateKey: clean(options.credentials.apiPrivateKey),
      organizationId: clean(options.credentials.organizationId) || undefined,
      policyId: clean(options.credentials.policyId) || undefined,
      baseUrl: clean(options.credentials.baseUrl) || undefined,
      rpcUrl: clean(options.credentials.rpcUrl) || undefined,
      defaultSolanaAddress: clean(options.credentials.defaultSolanaAddress) || undefined,
      providerWalletId: clean(options.credentials.providerWalletId) || undefined,
    };
    this.walletName = clean(options.walletName) || `FasedAgent Solana ${Date.now()}`;
    this.stateEnv = options.stateEnv ?? process.env;
    this.dependencies = options.dependencies ?? {};
    this.capabilities = {
      custodyModel: "provider-managed",
      supportsCreateWallet: true,
      supportsPrepare: true,
      supportsSend: true,
      supportsRotateKeys: false,
      supportsResetKeys: false,
      supportsPasskeyGate: false,
      signingLocation: "server",
      supportsSignTransaction: true,
      supportsSignMessage: false,
      supportedExecutionModes: ["manual"],
      supportedChains: ["solana"],
    };
  }

  supportsChain(chain: WalletChain): boolean {
    return chain === "solana";
  }

  async health(): Promise<WalletProviderHealth> {
    const checkedAt = new Date().toISOString();
    const missing = this.missingConfiguration({ requireAddress: false });
    if (missing.length > 0) {
      return {
        ok: false,
        provider: this.id,
        configured: false,
        checkedAt,
        details: `Turnkey requires ${missing.join(", ")}. Use a dedicated API user covered by a restrictive Turnkey organization policy.`,
      };
    }
    try {
      const client = await this.getClient();
      const policyResponse = await client.getPolicy({
        organizationId: this.requireOrganizationId(),
        policyId: this.requirePolicyId(),
      });
      const policy = policyResponse.policy;
      if (
        clean(policy?.policyId) !== this.requirePolicyId() ||
        policy?.effect !== "EFFECT_ALLOW" ||
        !clean(policy?.condition)
      ) {
        throw new Error(
          "configured policy reference must resolve to an EFFECT_ALLOW policy with a non-empty condition",
        );
      }
      if (this.credentials.defaultSolanaAddress) {
        await this.getBalance("solana");
      }
      return {
        ok: true,
        provider: this.id,
        configured: true,
        checkedAt,
        details: this.credentials.defaultSolanaAddress
          ? "Turnkey API, an ALLOW policy reference with a selector, Solana account, and RPC are reachable. This does not prove that the selector covers this API user; Turnkey remains final policy authority."
          : "Turnkey API and an ALLOW policy reference with a selector are reachable. This does not prove that the selector covers this API user; create or register a Solana account next.",
      };
    } catch (error) {
      return {
        ok: false,
        provider: this.id,
        configured: true,
        checkedAt,
        details: `Turnkey readiness check failed: ${walletDiagnosticErrorMessage(error)}`,
      };
    }
  }

  async createWallet(): Promise<WalletProviderCreateWalletResult> {
    this.assertConfigured({ requireAddress: false });
    try {
      const created = await (
        await this.getClient()
      ).createWallet({
        organizationId: this.requireOrganizationId(),
        walletName: this.walletName,
        accounts: [defaultSolanaAccountAtIndex(0)],
      });
      const address = clean(created.addresses[0]);
      if (!address) {
        throw new Error("Turnkey returned no Solana address");
      }
      return {
        ok: true,
        walletId: created.walletId,
        addresses: { solana: address },
        metadata: {
          turnkeyWalletId: created.walletId,
          turnkeyPolicyId: this.requirePolicyId(),
          providerManaged: true,
        },
      };
    } catch (error) {
      throw asProviderError(error, "wallet creation");
    }
  }

  async getAddresses(): Promise<WalletProviderAddressMap> {
    return this.credentials.defaultSolanaAddress
      ? { solana: this.credentials.defaultSolanaAddress }
      : {};
  }

  async getBalance(chain: WalletChain): Promise<WalletProviderBalanceResult> {
    this.ensureSolana(chain);
    this.assertConfigured({ requireAddress: true });
    const address = this.requireAddress();
    const result = await fetchSolanaRpc<{ value?: number | string }>(
      this.requireRpcUrl(),
      "getBalance",
      [address, { commitment: "confirmed" }],
    );
    if (typeof result?.value !== "number" && typeof result?.value !== "string") {
      throw new WalletProviderError({
        code: "wallet_provider_unavailable",
        message: "Solana RPC did not return the Turnkey wallet balance",
        retryable: false,
      });
    }
    return {
      ok: true,
      chain: "solana",
      address,
      balance: String(result.value),
      unit: "lamports",
    };
  }

  async prepareTx(request: WalletProviderPrepareTxRequest): Promise<WalletProviderPrepareTxResult> {
    this.ensureSolana(request.chain);
    this.assertConfigured({ requireAddress: true });
    try {
      const prepared = await prepareTurnkeyReviewedTransaction({
        request,
        signerAddress: this.requireAddress(),
        rpcUrl: this.requireRpcUrl(),
        authorizationContext: this.authorizationContext(),
        env: this.stateEnv,
      });
      return {
        ok: true,
        chain: "solana",
        preparedId: prepared.preparedId,
        signer: prepared.signer,
        unsignedTxBase64: prepared.unsignedTxBase64,
        messageBase64: prepared.messageBase64,
        intentDigest: prepared.intentDigest,
        expiresAt: prepared.expiresAt,
        metadata: {
          simulation: prepared.simulation,
          recentBlockhash: prepared.recentBlockhash,
          lastValidBlockHeight: prepared.lastValidBlockHeight,
          expiresAt: prepared.expiresAt,
          turnkeyPolicyId: this.requirePolicyId(),
        },
      };
    } catch (error) {
      throw asProviderError(error, "transaction preparation");
    }
  }

  async sendTx(request: WalletProviderSendTxRequest): Promise<WalletProviderSendTxResult> {
    this.ensureSolana(request.chain);
    this.assertConfigured({ requireAddress: true });
    try {
      const preparedId = clean(request.preparedId);
      if (!preparedId) {
        throw new WalletProviderError({
          code: "wallet_provider_invalid_config",
          message: "Turnkey manual send requires prepareTx and its reviewed preparedId",
        });
      }
      const executed = await executeTurnkeyReviewedTransaction({
        preparedId,
        request,
        signerAddress: this.requireAddress(),
        rpcUrl: this.requireRpcUrl(),
        authorizationContext: this.authorizationContext(),
        env: this.stateEnv,
        sign: async (unsignedTxBase64) => {
          const unsignedTransaction = Transaction.from(Buffer.from(unsignedTxBase64, "base64"));
          const client = await this.getClient();
          const signedTransaction = this.dependencies.signTransaction
            ? await this.dependencies.signTransaction({
                client,
                organizationId: this.requireOrganizationId(),
                transaction: unsignedTransaction,
                signerAddress: this.requireAddress(),
              })
            : await this.signWithTurnkey({ client, transaction: unsignedTransaction });
          return Buffer.from(
            signedTransaction.serialize({ requireAllSignatures: true, verifySignatures: true }),
          ).toString("base64");
        },
      });
      return {
        ok: true,
        chain: "solana",
        txHash: executed.txHash,
        signer: executed.signer,
        metadata: {
          intentDigest: executed.intentDigest,
          turnkeyPolicyId: this.requirePolicyId(),
          sendAttempts: executed.idempotent ? 0 : 1,
          idempotent: executed.idempotent,
        },
      };
    } catch (error) {
      throw asProviderError(error, "transaction signing or broadcast");
    }
  }

  private missingConfiguration(options: { requireAddress: boolean }): string[] {
    return [
      !this.credentials.apiPublicKey ? "API public key" : "",
      !this.credentials.apiPrivateKey ? "API private key" : "",
      !this.credentials.organizationId ? "organization ID" : "",
      !this.credentials.policyId ? "policy ID" : "",
      !this.credentials.rpcUrl ? "Solana RPC URL" : "",
      options.requireAddress && !this.credentials.defaultSolanaAddress ? "Solana address" : "",
    ].filter(Boolean);
  }

  private assertConfigured(options: { requireAddress: boolean }): void {
    const missing = this.missingConfiguration(options);
    if (missing.length > 0) {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message: `Turnkey requires ${missing.join(", ")}`,
      });
    }
  }

  private ensureSolana(chain: WalletChain): void {
    if (chain !== "solana") {
      throw new WalletProviderError({
        code: "wallet_provider_unsupported_chain",
        message: "Turnkey adapter supports Solana only",
      });
    }
  }

  private requireOrganizationId(): string {
    return this.credentials.organizationId!;
  }

  private requirePolicyId(): string {
    return this.credentials.policyId!;
  }

  private requireAddress(): string {
    return this.credentials.defaultSolanaAddress!;
  }

  private requireRpcUrl(): string {
    return this.credentials.rpcUrl!;
  }

  private authorizationContext(): string {
    return JSON.stringify({
      organizationId: this.requireOrganizationId(),
      policyId: this.requirePolicyId(),
      providerWalletId: this.credentials.providerWalletId ?? null,
    });
  }

  private async getClient(): Promise<TurnkeyApiClient> {
    this.clientPromise ??= Promise.resolve(
      this.dependencies.createClient
        ? this.dependencies.createClient()
        : new Turnkey({
            apiBaseUrl: this.credentials.baseUrl ?? DEFAULT_TURNKEY_API_BASE_URL,
            apiPublicKey: this.credentials.apiPublicKey,
            apiPrivateKey: this.credentials.apiPrivateKey,
            defaultOrganizationId: this.requireOrganizationId(),
          }).apiClient(),
    );
    return await this.clientPromise;
  }

  private async signWithTurnkey(params: {
    client: TurnkeyApiClient;
    transaction: Transaction;
  }): Promise<Transaction> {
    const signed = await new TurnkeySigner({
      organizationId: this.requireOrganizationId(),
      client: params.client,
    }).signTransaction(params.transaction, this.requireAddress());
    if (!(signed instanceof Transaction)) {
      throw new Error("Turnkey returned an unexpected Solana transaction version");
    }
    return signed;
  }
}
