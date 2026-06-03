import net from "node:net";
import path from "node:path";
import type { WalletChain } from "../../config/types.wallet.js";
import {
  parseLocalSocketSignerResponseEnvelope,
  validateLocalSocketSignerResult,
  type LocalSocketSignerRequest,
} from "../local-socket-signer-protocol.js";
import { fetchSolanaMintInfoViaRpc } from "../solana-assets.js";
import {
  buildCreateAssociatedTokenAccountIdempotentInstruction,
  buildTransferCheckedInstruction,
  deriveAssociatedTokenAddress,
} from "../solana-spl-transfer.js";
import {
  type WalletProviderAdapter,
  type WalletProviderAddressMap,
  type WalletProviderBalanceResult,
  type WalletProviderCapabilities,
  type WalletProviderHealth,
  type WalletProviderPrepareTxRequest,
  type WalletProviderPrepareTxResult,
  type WalletProviderSendTxRequest,
  type WalletProviderSendTxResult,
  type WalletProviderSignTxResult,
  WalletProviderError,
} from "../wallet-provider-adapter.js";
import {
  redactWalletDiagnosticText,
  walletDiagnosticErrorMessage,
  walletDiagnosticErrorString,
} from "../wallet-redaction.js";
import { ensureWalletStateDir } from "../wallet-runtime-config.js";

export type LocalSocketSignerHealthProbe = {
  ok: boolean;
  details?: string;
  readOnly?: boolean;
  keystoreType?: string;
  chains?: WalletChain[];
};

async function callSocket<T>(socketPath: string, payload: LocalSocketSignerRequest): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf("\n");
      if (idx < 0) {
        return;
      }
      const line = buf.slice(0, idx);
      socket.end();
      try {
        const parsed = parseLocalSocketSignerResponseEnvelope(JSON.parse(line) as unknown);
        if (!parsed.ok) {
          reject(new Error(parsed.error || "local socket signer error"));
          return;
        }
        if (!validateLocalSocketSignerResult(payload.op, parsed.result)) {
          reject(new Error(`invalid local socket signer result for op=${payload.op}`));
          return;
        }
        resolve(parsed.result as T);
      } catch (err) {
        reject(err);
      }
    });
    socket.on("error", (err) => reject(err));
  });
}

export async function callLocalSocketSigner<T>(
  socketPath: string,
  payload: LocalSocketSignerRequest,
): Promise<T> {
  return await callSocket<T>(socketPath, payload);
}

export async function probeLocalSocketSignerHealth(
  socketPath: string,
): Promise<LocalSocketSignerHealthProbe> {
  try {
    const result = await callSocket<{
      details?: string;
      readOnly?: boolean;
      keystoreType?: string;
      chains?: WalletChain[];
    }>(socketPath, { op: "health" });
    return {
      ok: true,
      details: result?.details ? redactWalletDiagnosticText(result.details) : undefined,
      readOnly: result?.readOnly,
      keystoreType: result?.keystoreType,
      chains: Array.isArray(result?.chains) ? result.chains : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      details: walletDiagnosticErrorMessage(err),
    };
  }
}

export class LocalSocketSignerAdapter implements WalletProviderAdapter {
  readonly id = "local-socket-signer" as const;
  readonly displayName = "Local Socket Signer";
  readonly capabilities: WalletProviderCapabilities = {
    custodyModel: "self-hosted",
    supportsCreateWallet: false,
    supportsPrepare: true,
    supportsSend: true,
    supportsRotateKeys: false,
    supportsResetKeys: false,
    supportsPasskeyGate: false,
    supportedExecutionModes: ["manual", "autonomous"],
    supportedChains: ["solana"],
  };

  constructor(
    private readonly socketPath: string,
    private readonly options?: {
      backendSocketPath?: string;
      rpcUrl?: string;
      scopedWalletId?: string;
    },
  ) {}

  supportsChain(chain: WalletChain): boolean {
    return this.capabilities.supportedChains.includes(chain);
  }

  async health(): Promise<WalletProviderHealth> {
    try {
      const details = await probeLocalSocketSignerHealth(this.socketPath);
      if (!details.ok) {
        throw new Error(details.details || "local socket signer unavailable");
      }
      return {
        ok: true,
        provider: this.id,
        configured: true,
        checkedAt: new Date().toISOString(),
        details:
          details?.details ??
          [
            details?.readOnly ? "read-only" : "read-write",
            details?.keystoreType ? `keystore=${details.keystoreType}` : "",
            Array.isArray(details?.chains) ? `chains=${details.chains.join(",")}` : "",
          ]
            .filter(Boolean)
            .join(" "),
      };
    } catch (err) {
      return {
        ok: false,
        provider: this.id,
        configured: Boolean(this.socketPath),
        checkedAt: new Date().toISOString(),
        details: walletDiagnosticErrorString(err),
      };
    }
  }

  async getAddresses(options?: { walletId?: string }): Promise<WalletProviderAddressMap> {
    const walletId = options?.walletId?.trim() || this.options?.scopedWalletId?.trim();
    return await callSocket<WalletProviderAddressMap>(this.socketPath, {
      op: "getAddresses",
      ...(walletId ? { walletId } : {}),
    });
  }

  async getBalance(
    chain: WalletChain,
    options?: { walletId?: string },
  ): Promise<WalletProviderBalanceResult> {
    const walletId = options?.walletId?.trim() || this.options?.scopedWalletId?.trim();
    return await callSocket<WalletProviderBalanceResult>(this.socketPath, {
      op: "getBalance",
      chain,
      ...(walletId ? { walletId } : {}),
    });
  }

  async prepareTx(request: WalletProviderPrepareTxRequest): Promise<WalletProviderPrepareTxResult> {
    return await callSocket<WalletProviderPrepareTxResult>(this.socketPath, {
      op: "prepareTx",
      request,
    });
  }

  async sendTx(request: WalletProviderSendTxRequest): Promise<WalletProviderSendTxResult> {
    if (request.chain === "solana" && request.program?.trim()) {
      return await this.sendSplTokenTx(request);
    }
    return await callSocket<WalletProviderSendTxResult>(this.socketPath, { op: "sendTx", request });
  }

  async signTx(request: WalletProviderSendTxRequest): Promise<WalletProviderSignTxResult> {
    return await callSocket<WalletProviderSignTxResult>(this.socketPath, { op: "signTx", request });
  }

  private async sendSplTokenTx(
    request: WalletProviderSendTxRequest,
  ): Promise<WalletProviderSendTxResult> {
    const mint = request.program?.trim();
    const destinationOwner = request.to?.trim();
    const amountRaw = request.amount?.trim();
    if (!mint || !destinationOwner || !amountRaw) {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message: "local-socket-signer SPL send requires mint, destination, and amount",
      });
    }
    const rpcUrl = this.options?.rpcUrl?.trim();
    if (!rpcUrl) {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message: "local-socket-signer SPL send requires a Solana RPC URL",
      });
    }
    const walletId = this.options?.scopedWalletId?.trim();
    const addresses = await this.getAddresses(walletId ? { walletId } : undefined);
    const authority = addresses.solana?.trim();
    if (!authority) {
      throw new WalletProviderError({
        code: "wallet_provider_unavailable",
        message: "local-socket-signer wallet has no Solana address",
      });
    }
    const mintInfo = await fetchSolanaMintInfoViaRpc({ rpcUrl, mint });
    if (!mintInfo) {
      throw new WalletProviderError({
        code: "wallet_provider_unavailable",
        message: "failed to resolve SPL mint metadata from Solana RPC",
      });
    }
    const sourceTokenAccount = await deriveAssociatedTokenAddress({
      owner: authority,
      mint,
      tokenProgramId: mintInfo.tokenProgramId,
    });
    const destinationTokenAccount = await deriveAssociatedTokenAddress({
      owner: destinationOwner,
      mint,
      tokenProgramId: mintInfo.tokenProgramId,
    });
    const createAta = await buildCreateAssociatedTokenAccountIdempotentInstruction({
      payer: authority,
      owner: destinationOwner,
      mint,
      tokenProgramId: mintInfo.tokenProgramId,
    });
    const transfer = buildTransferCheckedInstruction({
      sourceTokenAccount,
      mint,
      destinationTokenAccount,
      authority,
      amountRaw,
      decimals: mintInfo.decimals,
      tokenProgramId: mintInfo.tokenProgramId,
    });
    const preTx = await this.sendSolanaInstruction({
      walletId,
      ...createAta,
    });
    const sent = await this.sendSolanaInstruction({
      walletId,
      ...transfer,
    });
    return {
      ...sent,
      metadata: {
        ...sent.metadata,
        provider: this.id,
        associatedTokenTxHash: preTx.txHash,
      },
    };
  }

  private async sendSolanaInstruction(request: {
    walletId?: string;
    programId: string;
    dataBase64: string;
    keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  }): Promise<WalletProviderSendTxResult> {
    const targetSocket = this.options?.backendSocketPath || this.socketPath;
    return await callSocket<WalletProviderSendTxResult>(targetSocket, {
      op: "sendSolanaInstruction",
      request,
    });
  }
}

export function resolveLocalSocketSignerPath(env: NodeJS.ProcessEnv): string {
  const socketPath = String(env.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? "").trim();
  if (socketPath) {
    return socketPath;
  }
  return path.join(ensureWalletStateDir(env).rootDir, "local-signer.sock");
}

export function requireLocalSocketSignerPath(env: NodeJS.ProcessEnv): string {
  return resolveLocalSocketSignerPath(env);
}
