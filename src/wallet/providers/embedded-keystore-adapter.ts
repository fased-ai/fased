import { createDecipheriv, randomUUID, scryptSync } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import type { WalletChain } from "../../config/types.wallet.js";
import { fetchSolanaMintInfoViaRpc } from "../solana-assets.js";
import {
  buildCreateAssociatedTokenAccountIdempotentInstruction,
  buildTransferCheckedInstruction,
  deriveAssociatedTokenAddress,
  toTransactionInstruction,
} from "../solana-spl-transfer.js";
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
import { walletDiagnosticErrorString } from "../wallet-redaction.js";

export type EmbeddedKeystoreAdapterOptions = {
  chains: WalletChain[];
  credentials?: {
    keystorePath?: string;
    passphrase?: string;
    rpcUrl?: string;
  };
  env?: NodeJS.ProcessEnv;
};

type PreparedTx = {
  solana?: {
    to: string;
    lamports: bigint;
    from: string;
  };
};
type SolanaKeystoreEnvelopeV1 = {
  kind: "fased-solana-keypair";
  version: 1;
  kdf: "scrypt";
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  publicKey: string;
};
type SolanaModuleLike = {
  Keypair: {
    fromSecretKey(secretKey: Uint8Array): { publicKey: { toBase58(): string } };
  };
  PublicKey: new (value: string) => { toBase58(): string };
  Connection: new (rpcUrl: string) => {
    getBalance(pubkey: { toBase58(): string }): Promise<number>;
    getLatestBlockhash(): Promise<{ blockhash: string }>;
    sendTransaction(
      tx: { recentBlockhash?: string; feePayer?: unknown },
      signers: Array<unknown>,
    ): Promise<string>;
    confirmTransaction(signature: string): Promise<unknown>;
  };
  SystemProgram: {
    transfer(params: { fromPubkey: unknown; toPubkey: unknown; lamports: number }): unknown;
  };
  Transaction: new () => {
    add(ix: unknown): unknown;
    recentBlockhash?: string;
    feePayer?: unknown;
  };
};
const require = createRequire(import.meta.url);
let solanaModulePromise: Promise<SolanaModuleLike> | null = null;

async function loadSolanaWeb3(): Promise<SolanaModuleLike> {
  solanaModulePromise ??= (async () => {
    try {
      return require("@solana/web3.js") as SolanaModuleLike;
    } catch {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message:
          "embedded-keystore Solana support requires optional '@solana/web3.js'. Run 'pnpm install' in the Fased repository to enable Solana.",
      });
    }
  })();
  return solanaModulePromise;
}

function normalizeChains(chains: WalletChain[]): WalletChain[] {
  const out = new Set<WalletChain>();
  for (const chain of chains) {
    if (chain === "solana") {
      out.add(chain);
    }
  }
  return out.size > 0 ? [...out] : ["solana"];
}

function parseAmountLamports(raw?: string): bigint | undefined {
  const text = (raw ?? "").trim();
  if (!text) {
    return undefined;
  }
  try {
    return BigInt(text);
  } catch {
    throw new WalletProviderError({
      code: "wallet_provider_invalid_config",
      message: `invalid amount (expected lamports integer): ${text}`,
    });
  }
}

function parseSolanaKeystoreEnvelope(raw: string): SolanaKeystoreEnvelopeV1 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SolanaKeystoreEnvelopeV1>;
    if (
      parsed.kind !== "fased-solana-keypair" ||
      parsed.version !== 1 ||
      parsed.kdf !== "scrypt" ||
      parsed.cipher !== "aes-256-gcm"
    ) {
      return null;
    }
    if (
      typeof parsed.salt !== "string" ||
      typeof parsed.iv !== "string" ||
      typeof parsed.authTag !== "string" ||
      typeof parsed.ciphertext !== "string" ||
      typeof parsed.publicKey !== "string"
    ) {
      return null;
    }
    return parsed as SolanaKeystoreEnvelopeV1;
  } catch {
    return null;
  }
}

function decryptSolanaKeypairEnvelope(
  envelope: SolanaKeystoreEnvelopeV1,
  passphrase: string,
): Uint8Array {
  const salt = Buffer.from(envelope.salt, "base64url");
  const iv = Buffer.from(envelope.iv, "base64url");
  const authTag = Buffer.from(envelope.authTag, "base64url");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
  const key = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plaintext.length !== 64) {
    throw new WalletProviderError({
      code: "wallet_provider_invalid_config",
      message: "invalid Solana keystore secret length",
    });
  }
  return Uint8Array.from(plaintext);
}

function detectKeystoreType(raw: string): "solana-envelope" | "unknown" {
  return parseSolanaKeystoreEnvelope(raw) ? "solana-envelope" : "unknown";
}

export class EmbeddedKeystoreAdapter implements WalletProviderAdapter {
  readonly id = "embedded-keystore" as const;
  readonly displayName = "Embedded Encrypted Keystore";
  readonly capabilities: WalletProviderAdapter["capabilities"];

  private readonly chains: WalletChain[];
  private readonly keystorePath: string;
  private readonly passphrase: string;
  private readonly rpcUrl: string;
  private readonly prepared = new Map<string, PreparedTx>();
  private readonly defaultSolanaAddress?: string;

  private solanaKeypairPromise: Promise<{ publicKey: { toBase58(): string } }> | null = null;
  private solanaConnectionPromise: Promise<InstanceType<SolanaModuleLike["Connection"]>> | null =
    null;

  constructor(options: EmbeddedKeystoreAdapterOptions) {
    const env = options.env ?? process.env;
    this.chains = normalizeChains(options.chains);
    this.keystorePath =
      options.credentials?.keystorePath?.trim() ||
      String(env.FASED_WALLET_KEYSTORE_PATH ?? "").trim() ||
      "";
    this.passphrase =
      options.credentials?.passphrase?.trim() ||
      String(env.FASED_WALLET_PASSPHRASE ?? "").trim() ||
      "";
    this.rpcUrl =
      options.credentials?.rpcUrl?.trim() ||
      String(env.FASED_WALLET_EMBEDDED_KEYSTORE_RPC_URL ?? "").trim() ||
      String(env.FASED_WALLET_RPC_URL ?? "").trim() ||
      "";
    this.defaultSolanaAddress =
      String(env.FASED_WALLET_KEYSTORE_DEFAULT_SOLANA_ADDRESS ?? "").trim() || undefined;

    this.capabilities = {
      custodyModel: "self-hosted",
      supportsCreateWallet: false,
      supportsPrepare: true,
      supportsSend: true,
      supportsRotateKeys: false,
      supportsResetKeys: false,
      supportsPasskeyGate: false,
      signingLocation: "server",
      supportsSignTransaction: true,
      supportsSignMessage: false,
      supportedExecutionModes: ["manual", "autonomous"],
      supportedChains: [...this.chains],
    };
  }

  supportsChain(chain: WalletChain): boolean {
    return this.capabilities.supportedChains.includes(chain);
  }

  async health(): Promise<WalletProviderHealth> {
    const configured = Boolean(this.keystorePath && this.passphrase && this.rpcUrl);
    if (!configured) {
      return {
        ok: false,
        provider: this.id,
        configured: false,
        checkedAt: new Date().toISOString(),
        details:
          "missing embedded keystore config (FASED_WALLET_KEYSTORE_PATH, FASED_WALLET_PASSPHRASE, FASED_WALLET_[EMBEDDED_KEYSTORE_]RPC_URL)",
      };
    }
    if (!fs.existsSync(this.keystorePath)) {
      return {
        ok: false,
        provider: this.id,
        configured: true,
        checkedAt: new Date().toISOString(),
        details: `keystore file not found: ${this.keystorePath}`,
      };
    }
    try {
      const raw = await fs.promises.readFile(this.keystorePath, "utf8");
      if (detectKeystoreType(raw) !== "solana-envelope") {
        throw new Error("keystore file is not a Solana keystore envelope");
      }
      const [address, lamports] = await Promise.all([
        this.getSolanaAddress(),
        this.getSolanaBalanceLamports(),
      ]);
      return {
        ok: true,
        provider: this.id,
        configured: true,
        checkedAt: new Date().toISOString(),
        details: `keystore unlocked (solana address=${address}, lamports=${lamports})`,
      };
    } catch (err) {
      return {
        ok: false,
        provider: this.id,
        configured: true,
        checkedAt: new Date().toISOString(),
        details: `embedded keystore check failed: ${walletDiagnosticErrorString(err)}`,
      };
    }
  }

  async createWallet(): Promise<WalletProviderCreateWalletResult> {
    throw new WalletProviderError({
      code: "wallet_provider_not_implemented",
      message: "Use `fased wallet keystore init` to create an embedded keystore",
    });
  }

  async getAddresses(): Promise<WalletProviderAddressMap> {
    const result: WalletProviderAddressMap = {};
    if (!this.keystorePath || !this.passphrase) {
      if (this.supportsChain("solana")) {
        result.solana = this.defaultSolanaAddress;
      }
      return result;
    }
    try {
      const raw = await fs.promises.readFile(this.keystorePath, "utf8");
      const type = detectKeystoreType(raw);
      if (type === "solana-envelope") {
        if (this.supportsChain("solana")) {
          result.solana = await this.getSolanaAddress();
        }
      }
      return result;
    } catch {
      if (this.supportsChain("solana")) {
        result.solana = this.defaultSolanaAddress;
      }
      return result;
    }
  }

  async getBalance(chain: WalletChain): Promise<WalletProviderBalanceResult> {
    if (chain === "solana") {
      this.ensureSolanaChain(chain);
      const address = await this.getSolanaAddress();
      const lamports = await this.getSolanaBalanceLamports();
      return { ok: true, chain, address, balance: String(lamports), unit: "lamports" };
    }
    this.ensureSolanaChain(chain);
    throw new WalletProviderError({
      code: "wallet_provider_unsupported_chain",
      message: "embedded-keystore supports Solana only",
    });
  }

  async prepareTx(request: WalletProviderPrepareTxRequest): Promise<WalletProviderPrepareTxResult> {
    if (request.chain === "solana") {
      this.ensureSolanaChain(request.chain);
      if (request.program) {
        throw new WalletProviderError({
          code: "wallet_provider_not_implemented",
          message: "embedded-keystore Solana program calls are not implemented yet",
        });
      }
      if (!request.to?.trim()) {
        throw new WalletProviderError({
          code: "wallet_provider_invalid_config",
          message: "embedded-keystore prepareTx requires `to` for Solana transfer",
        });
      }
      const from = await this.getSolanaAddress();
      const lamports = parseAmountLamports(request.amount) ?? 0n;
      const preparedId = randomUUID();
      this.prepared.set(preparedId, {
        solana: { to: request.to.trim(), lamports, from },
      });
      return {
        ok: true,
        chain: "solana",
        preparedId,
        signer: from,
        metadata: { kind: "native-transfer", to: request.to.trim(), lamports: lamports.toString() },
      };
    }
    this.ensureSolanaChain(request.chain);
    throw new WalletProviderError({
      code: "wallet_provider_unsupported_chain",
      message: "embedded-keystore supports Solana only",
    });
  }

  async sendTx(request: WalletProviderSendTxRequest): Promise<WalletProviderSendTxResult> {
    if (request.chain === "solana") {
      this.ensureSolanaChain(request.chain);
      if (request.program?.trim()) {
        const mint = request.program.trim();
        const destinationOwner = request.to?.trim();
        const amountRaw = request.amount?.trim();
        if (!destinationOwner || !amountRaw) {
          throw new WalletProviderError({
            code: "wallet_provider_invalid_config",
            message: "embedded-keystore SPL send requires destination and amount",
          });
        }
        if (!this.rpcUrl) {
          throw new WalletProviderError({
            code: "wallet_provider_invalid_config",
            message: "embedded-keystore missing RPC URL",
          });
        }
        const mintInfo = await fetchSolanaMintInfoViaRpc({
          rpcUrl: this.rpcUrl,
          mint,
        });
        if (!mintInfo) {
          throw new WalletProviderError({
            code: "wallet_provider_unavailable",
            message: "failed to resolve SPL mint metadata from Solana RPC",
          });
        }
        const [connection, keypair] = await Promise.all([
          this.getSolanaConnection(),
          this.getSolanaKeypair(),
        ]);
        const authority = keypair.publicKey.toBase58();
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
        const tx = new (await loadSolanaWeb3()).Transaction();
        tx.add(
          await toTransactionInstruction(
            await buildCreateAssociatedTokenAccountIdempotentInstruction({
              payer: authority,
              owner: destinationOwner,
              mint,
              tokenProgramId: mintInfo.tokenProgramId,
            }),
          ),
        );
        tx.add(
          await toTransactionInstruction(
            buildTransferCheckedInstruction({
              sourceTokenAccount,
              mint,
              destinationTokenAccount,
              authority,
              amountRaw,
              decimals: mintInfo.decimals,
              tokenProgramId: mintInfo.tokenProgramId,
            }),
          ),
        );
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = keypair.publicKey;
        const txHash = await connection.sendTransaction(tx, [keypair]);
        await connection.confirmTransaction(txHash);
        return {
          ok: true,
          chain: "solana",
          txHash,
          signer: authority,
        };
      }
      let prepared = request.preparedId ? this.prepared.get(request.preparedId) : undefined;
      if (!prepared?.solana) {
        const next = await this.prepareTx(request);
        prepared = this.prepared.get(next.preparedId);
      }
      if (!prepared?.solana) {
        throw new WalletProviderError({
          code: "wallet_provider_unavailable",
          message: "failed to resolve embedded keystore Solana transaction",
        });
      }
      const solana = await loadSolanaWeb3();
      const [connection, keypair] = await Promise.all([
        this.getSolanaConnection(),
        this.getSolanaKeypair(),
      ]);
      const tx = new solana.Transaction();
      tx.add(
        solana.SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: new solana.PublicKey(prepared.solana.to),
          lamports: Number(prepared.solana.lamports),
        }),
      );
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = keypair.publicKey;
      const txHash = await connection.sendTransaction(tx, [keypair]);
      await connection.confirmTransaction(txHash);
      return {
        ok: true,
        chain: "solana",
        txHash,
        signer: prepared.solana.from,
      };
    }
    this.ensureSolanaChain(request.chain);
    throw new WalletProviderError({
      code: "wallet_provider_unsupported_chain",
      message: "embedded-keystore supports Solana only",
    });
  }

  private ensureSolanaChain(chain: WalletChain): void {
    if (chain !== "solana" || !this.supportsChain(chain)) {
      throw new WalletProviderError({
        code: "wallet_provider_unsupported_chain",
        message:
          "embedded-keystore currently supports Solana only when configured with a Solana keystore",
      });
    }
  }

  private async getSolanaConnection(): Promise<InstanceType<SolanaModuleLike["Connection"]>> {
    if (!this.rpcUrl) {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message: "embedded-keystore missing RPC URL",
      });
    }
    this.solanaConnectionPromise ??= (async () => {
      const solana = await loadSolanaWeb3();
      return new solana.Connection(this.rpcUrl);
    })();
    return this.solanaConnectionPromise;
  }

  private async getSolanaKeypair(): Promise<{ publicKey: { toBase58(): string } }> {
    if (!this.keystorePath || !this.passphrase) {
      throw new WalletProviderError({
        code: "wallet_provider_invalid_config",
        message: "embedded-keystore missing keystore path or passphrase",
      });
    }
    this.solanaKeypairPromise ??= (async () => {
      const raw = await fs.promises.readFile(this.keystorePath, "utf8");
      const envelope = parseSolanaKeystoreEnvelope(raw);
      if (!envelope) {
        throw new WalletProviderError({
          code: "wallet_provider_invalid_config",
          message: "embedded-keystore file is not a Solana keystore envelope",
        });
      }
      const secretKey = decryptSolanaKeypairEnvelope(envelope, this.passphrase);
      const solana = await loadSolanaWeb3();
      return solana.Keypair.fromSecretKey(secretKey);
    })();
    return this.solanaKeypairPromise;
  }

  private async getSolanaAddress(): Promise<string> {
    return (await this.getSolanaKeypair()).publicKey.toBase58();
  }

  private async getSolanaBalanceLamports(): Promise<number> {
    const [conn, kp] = await Promise.all([this.getSolanaConnection(), this.getSolanaKeypair()]);
    return conn.getBalance(kp.publicKey);
  }
}
