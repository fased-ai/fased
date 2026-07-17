import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, Transaction } from "@solana/web3.js";
import type { TurnkeyApiClient } from "@turnkey/sdk-server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WalletProviderError } from "../wallet-provider-adapter.js";
import { TurnkeyAdapter } from "./turnkey-adapter.js";

const temporaryDirectories: string[] = [];

function encodeBase58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let result = "";
  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }
    result += "1";
  }
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    result += alphabet[digits[index]];
  }
  return result;
}

function testEnv(): NodeJS.ProcessEnv {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-turnkey-review-"));
  temporaryDirectories.push(stateDir);
  return { ...process.env, FASED_STATE_DIR: stateDir };
}

function fakeClient(overrides: Record<string, unknown> = {}): TurnkeyApiClient {
  return {
    getPolicy: vi.fn().mockResolvedValue({
      policy: {
        policyId: "policy-1",
        effect: "EFFECT_ALLOW",
        condition: "credential matches dedicated API user",
      },
    }),
    createWallet: vi.fn().mockResolvedValue({
      walletId: "provider-wallet-1",
      addresses: [Keypair.generate().publicKey.toBase58()],
    }),
    ...overrides,
  } as unknown as TurnkeyApiClient;
}

function createAdapter(params?: {
  signer?: Keypair;
  client?: TurnkeyApiClient;
  policyId?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const signer = params?.signer;
  const client = params?.client ?? fakeClient();
  return new TurnkeyAdapter({
    chains: ["solana"],
    credentials: {
      apiPublicKey: "turnkey-public",
      apiPrivateKey: "turnkey-private",
      organizationId: "organization-1",
      policyId: params?.policyId ?? "policy-1",
      rpcUrl: "https://rpc.invalid",
      defaultSolanaAddress: signer?.publicKey.toBase58(),
    },
    service: { host: "127.0.0.1", port: 0 },
    stateEnv: params?.env,
    dependencies: {
      createClient: () => client,
      signTransaction: signer
        ? async ({ transaction }) => {
            transaction.partialSign(signer);
            return transaction;
          }
        : undefined,
    },
  });
}

function installRpcMock(params?: {
  broadcast: "success" | "unknown";
  reconciliation?: "pending" | "landed" | "failed" | "expired";
}) {
  const blockhash = Keypair.generate().publicKey.toBase58();
  const methods: string[] = [];
  let expectedSignature = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (typeof init?.body !== "string") {
        throw new Error("expected JSON RPC request body");
      }
      const body = JSON.parse(init.body) as { method: string; params: unknown[] };
      methods.push(body.method);
      let result: unknown;
      if (body.method === "getLatestBlockhash") {
        result = { value: { blockhash, lastValidBlockHeight: 123 } };
      } else if (body.method === "simulateTransaction") {
        result = { value: { err: null, unitsConsumed: 321 } };
      } else if (body.method === "sendTransaction") {
        const signed = Transaction.from(Buffer.from(String(body.params[0]), "base64"));
        expectedSignature = encodeBase58(signed.signature!);
        result = params?.broadcast === "unknown" ? null : expectedSignature;
      } else if (body.method === "getSignatureStatuses") {
        if (params?.reconciliation === "landed") {
          result = { value: [{ err: null, confirmationStatus: "confirmed", confirmations: 1 }] };
        } else if (params?.reconciliation === "failed") {
          result = {
            value: [{ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }],
          };
        } else {
          result = { value: [null] };
        }
      } else if (body.method === "getBlockHeight") {
        result = params?.reconciliation === "expired" ? 124 : 100;
      } else {
        throw new Error(`unexpected RPC method ${body.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return { methods, getExpectedSignature: () => expectedSignature };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("TurnkeyAdapter", () => {
  test("fails closed without the organization, policy, and RPC scope", async () => {
    const adapter = new TurnkeyAdapter({
      chains: ["solana"],
      credentials: { apiPublicKey: "public", apiPrivateKey: "private" },
      service: { host: "127.0.0.1", port: 0 },
    });

    const health = await adapter.health();
    expect(health).toMatchObject({ ok: false, configured: false });
    expect(health.details).toContain("organization ID");
    expect(health.details).toContain("policy ID");
    expect(adapter.capabilities).toMatchObject({
      signingLocation: "server",
      supportsCreateWallet: true,
      supportsPrepare: true,
      supportsSend: true,
      supportedExecutionModes: ["manual"],
    });
  });

  test("checks the policy reference and creates a real provider wallet", async () => {
    const client = fakeClient();
    const adapter = createAdapter({ client });

    await expect(adapter.health()).resolves.toMatchObject({ ok: true, configured: true });
    const created = await adapter.createWallet();

    expect(client.getPolicy).toHaveBeenCalledWith({
      organizationId: "organization-1",
      policyId: "policy-1",
    });
    expect(client.createWallet).toHaveBeenCalledOnce();
    expect(created).toMatchObject({
      ok: true,
      walletId: "provider-wallet-1",
      metadata: { turnkeyPolicyId: "policy-1", providerManaged: true },
    });
  });

  test("does not treat policy ID existence alone as signing readiness", async () => {
    const client = fakeClient({
      getPolicy: vi.fn().mockResolvedValue({
        policy: { policyId: "policy-1", effect: "EFFECT_ALLOW", condition: "" },
      }),
    });

    const health = await createAdapter({ client }).health();

    expect(health).toMatchObject({ ok: false, configured: true });
    expect(health.details).toContain("non-empty condition");
  });

  test("requires a known prepared review and never falls back to a direct send", async () => {
    const signer = Keypair.generate();
    const adapter = createAdapter({ signer, env: testEnv() });
    const request = {
      chain: "solana" as const,
      to: Keypair.generate().publicKey.toBase58(),
      amount: "1",
    };

    await expect(adapter.sendTx(request)).rejects.toMatchObject({
      code: "wallet_provider_invalid_config",
    } satisfies Partial<WalletProviderError>);
    await expect(adapter.sendTx({ ...request, preparedId: "unknown" })).rejects.toMatchObject({
      code: "wallet_provider_invalid_config",
    } satisfies Partial<WalletProviderError>);
  });

  test("persists prepare across adapter restart and broadcasts the exact message once", async () => {
    const env = testEnv();
    const signer = Keypair.generate();
    const rpc = installRpcMock();
    const request = {
      chain: "solana" as const,
      to: Keypair.generate().publicKey.toBase58(),
      amount: "1000",
    };
    const prepared = await createAdapter({ signer, env }).prepareTx(request);

    const restarted = createAdapter({ signer, env });
    const sent = await restarted.sendTx({ ...request, preparedId: prepared.preparedId });

    expect(sent.txHash).toBe(rpc.getExpectedSignature());
    expect(sent.metadata).toMatchObject({
      turnkeyPolicyId: "policy-1",
      sendAttempts: 1,
      idempotent: false,
    });
    expect(rpc.methods).toEqual(["getLatestBlockhash", "simulateTransaction", "sendTransaction"]);
  });

  test("serializes concurrent execution and returns one idempotent result", async () => {
    const env = testEnv();
    const signer = Keypair.generate();
    const rpc = installRpcMock();
    const adapter = createAdapter({ signer, env });
    const request = {
      chain: "solana" as const,
      to: Keypair.generate().publicKey.toBase58(),
      amount: "42",
    };
    const prepared = await adapter.prepareTx(request);
    const execution = { ...request, preparedId: prepared.preparedId };

    const [first, second] = await Promise.all([
      adapter.sendTx(execution),
      adapter.sendTx(execution),
    ]);

    expect(first.txHash).toBe(second.txHash);
    expect(first.metadata?.idempotent).toBe(false);
    expect(second.metadata?.idempotent).toBe(true);
    expect(rpc.methods.filter((method) => method === "sendTransaction")).toHaveLength(1);
  });

  test("persists an ambiguous broadcast across restart and never retries it", async () => {
    const env = testEnv();
    const signer = Keypair.generate();
    const rpc = installRpcMock({ broadcast: "unknown" });
    const adapter = createAdapter({ signer, env });
    const request = {
      chain: "solana" as const,
      to: Keypair.generate().publicKey.toBase58(),
      amount: "7",
    };
    const prepared = await adapter.prepareTx(request);
    const execution = { ...request, preparedId: prepared.preparedId };

    await expect(adapter.sendTx(execution)).rejects.toMatchObject({
      code: "wallet_provider_ambiguous",
    });
    const persisted = JSON.parse(
      fs.readFileSync(path.join(env.FASED_STATE_DIR!, "wallet", "turnkey-reviews.v1.json"), "utf8"),
    ) as { reviews: Array<{ signedTxBase64?: string; txHash?: string; status?: string }> };
    expect(persisted.reviews[0]).toMatchObject({
      status: "unknown",
      txHash: rpc.getExpectedSignature(),
    });
    expect(persisted.reviews[0]?.signedTxBase64).toBeTruthy();
    await expect(createAdapter({ signer, env }).sendTx(execution)).rejects.toMatchObject({
      code: "wallet_provider_ambiguous",
    });
    expect(rpc.methods.filter((method) => method === "sendTransaction")).toHaveLength(1);
  });

  test("reconciles an ambiguous signature after restart without rebroadcasting", async () => {
    const env = testEnv();
    const signer = Keypair.generate();
    const rpc = installRpcMock({ broadcast: "unknown", reconciliation: "landed" });
    const request = {
      chain: "solana" as const,
      to: Keypair.generate().publicKey.toBase58(),
      amount: "8",
    };
    const prepared = await createAdapter({ signer, env }).prepareTx(request);
    const execution = { ...request, preparedId: prepared.preparedId };

    await expect(createAdapter({ signer, env }).sendTx(execution)).rejects.toMatchObject({
      code: "wallet_provider_ambiguous",
    });
    const reconciled = await createAdapter({ signer, env }).sendTx(execution);

    expect(reconciled).toMatchObject({
      txHash: rpc.getExpectedSignature(),
      metadata: { idempotent: true, sendAttempts: 0 },
    });
    expect(rpc.methods.filter((method) => method === "sendTransaction")).toHaveLength(1);
    expect(rpc.methods.filter((method) => method === "getSignatureStatuses")).toHaveLength(1);
  });

  test("records an expired ambiguous signature as failed before allowing a new review", async () => {
    const env = testEnv();
    const signer = Keypair.generate();
    const rpc = installRpcMock({ broadcast: "unknown", reconciliation: "expired" });
    const request = {
      chain: "solana" as const,
      to: Keypair.generate().publicKey.toBase58(),
      amount: "9",
    };
    const prepared = await createAdapter({ signer, env }).prepareTx(request);
    const execution = { ...request, preparedId: prepared.preparedId };

    await expect(createAdapter({ signer, env }).sendTx(execution)).rejects.toMatchObject({
      code: "wallet_provider_ambiguous",
    });
    await expect(createAdapter({ signer, env }).sendTx(execution)).rejects.toMatchObject({
      code: "wallet_provider_unavailable",
    });
    await expect(createAdapter({ signer, env }).sendTx(execution)).rejects.toMatchObject({
      code: "wallet_provider_unavailable",
    });
    expect(rpc.methods.filter((method) => method === "sendTransaction")).toHaveLength(1);
    expect(rpc.methods.filter((method) => method === "getSignatureStatuses")).toHaveLength(1);
  });
});
