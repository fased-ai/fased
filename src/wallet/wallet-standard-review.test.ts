import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, Transaction } from "@solana/web3.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  executeWalletStandardReview,
  prepareWalletStandardReview,
} from "./wallet-standard-review.js";

const temporaryDirectories: string[] = [];

function testEnv(): NodeJS.ProcessEnv {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-wallet-standard-review-"));
  temporaryDirectories.push(stateDir);
  return { ...process.env, FASED_STATE_DIR: stateDir };
}

function installRpcMock(params: { blockhash: string; broadcastResult?: string | null }) {
  const methods: string[] = [];
  let signedSignature = "";
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (typeof init?.body !== "string") {
      throw new Error("expected JSON RPC request body");
    }
    const body = JSON.parse(init.body) as { method: string; params: unknown[] };
    methods.push(body.method);
    let result: unknown;
    if (body.method === "getLatestBlockhash") {
      result = { value: { blockhash: params.blockhash, lastValidBlockHeight: 456 } };
    } else if (body.method === "getGenesisHash") {
      result = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    } else if (body.method === "simulateTransaction") {
      result = { value: { err: null, unitsConsumed: 111 } };
    } else if (body.method === "sendTransaction") {
      const signed = Transaction.from(Buffer.from(String(body.params[0]), "base64"));
      signedSignature = encodeBase58(signed.signature!);
      result = params.broadcastResult === undefined ? signedSignature : params.broadcastResult;
    } else {
      throw new Error(`unexpected RPC method ${body.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { methods, fetchMock, getSignedSignature: () => signedSignature };
}

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

function sign(unsignedTxBase64: string, signer: Keypair): string {
  const transaction = Transaction.from(Buffer.from(unsignedTxBase64, "base64"));
  transaction.partialSign(signer);
  return transaction.serialize().toString("base64");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Wallet Standard reviewed execution", () => {
  test("binds the browser signature to the exact reviewed message and broadcasts once", async () => {
    const env = testEnv();
    const signer = Keypair.generate();
    const rpc = installRpcMock({ blockhash: Keypair.generate().publicKey.toBase58() });
    const payload = {
      chain: "solana" as const,
      to: Keypair.generate().publicKey.toBase58(),
      amount: "1000",
      providerId: "wallet-standard" as const,
      walletId: "vault",
    };
    const review = await prepareWalletStandardReview({
      requestId: "request-1",
      payload,
      signerAddress: signer.publicKey.toBase58(),
      rpcUrl: "https://rpc.invalid",
      env,
    });
    const repeated = await prepareWalletStandardReview({
      requestId: "request-1",
      payload,
      signerAddress: signer.publicKey.toBase58(),
      rpcUrl: "https://rpc.invalid",
      env,
    });
    expect(repeated).toEqual(review);
    const signedTxBase64 = sign(review.unsignedTxBase64, signer);
    const execution = {
      requestId: review.requestId,
      preparedId: review.preparedId,
      intentDigest: review.intentDigest,
      signedTxBase64,
      rpcUrl: "https://rpc.invalid",
      env,
    };

    const [first, second] = await Promise.all([
      executeWalletStandardReview(execution),
      executeWalletStandardReview(execution),
    ]);

    expect(first).toMatchObject({ idempotent: false, txHash: rpc.getSignedSignature() });
    expect(second).toMatchObject({ idempotent: true, txHash: first.txHash });
    expect(rpc.methods.filter((method) => method === "sendTransaction")).toHaveLength(1);
    await expect(
      prepareWalletStandardReview({
        requestId: "request-1",
        payload,
        signerAddress: signer.publicKey.toBase58(),
        rpcUrl: "https://rpc.invalid",
        env,
      }),
    ).rejects.toThrow("immutable hardware-wallet review");
  });

  test("never replaces a request ID when intent changes or its review expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const env = testEnv();
    const signer = Keypair.generate();
    installRpcMock({ blockhash: Keypair.generate().publicKey.toBase58() });
    const payload = {
      chain: "solana" as const,
      to: Keypair.generate().publicKey.toBase58(),
      amount: "1",
      providerId: "wallet-standard" as const,
    };
    await prepareWalletStandardReview({
      requestId: "immutable-request",
      payload,
      signerAddress: signer.publicKey.toBase58(),
      rpcUrl: "https://rpc.invalid",
      env,
    });

    await expect(
      prepareWalletStandardReview({
        requestId: "immutable-request",
        payload: { ...payload, amount: "2" },
        signerAddress: signer.publicKey.toBase58(),
        rpcUrl: "https://rpc.invalid",
        env,
      }),
    ).rejects.toThrow("create a new approval request");
    vi.advanceTimersByTime(3 * 60 * 1000);
    await expect(
      prepareWalletStandardReview({
        requestId: "immutable-request",
        payload,
        signerAddress: signer.publicKey.toBase58(),
        rpcUrl: "https://rpc.invalid",
        env,
      }),
    ).rejects.toThrow("create a new approval request");
  });

  test("rejects a wallet-mutated message before broadcast", async () => {
    const env = testEnv();
    const signer = Keypair.generate();
    const rpc = installRpcMock({ blockhash: Keypair.generate().publicKey.toBase58() });
    const review = await prepareWalletStandardReview({
      requestId: "request-2",
      payload: {
        chain: "solana",
        to: Keypair.generate().publicKey.toBase58(),
        amount: "1",
        providerId: "wallet-standard",
      },
      signerAddress: signer.publicKey.toBase58(),
      rpcUrl: "https://rpc.invalid",
      env,
    });
    const changed = Transaction.from(Buffer.from(review.unsignedTxBase64, "base64"));
    changed.recentBlockhash = Keypair.generate().publicKey.toBase58();
    changed.partialSign(signer);

    await expect(
      executeWalletStandardReview({
        requestId: review.requestId,
        preparedId: review.preparedId,
        intentDigest: review.intentDigest,
        signedTxBase64: changed.serialize().toString("base64"),
        rpcUrl: "https://rpc.invalid",
        env,
      }),
    ).rejects.toMatchObject({ code: "wallet_provider_invalid_config" });
    expect(rpc.methods).not.toContain("sendTransaction");
  });

  test("marks an unknown broadcast terminal and never retries it", async () => {
    const env = testEnv();
    const signer = Keypair.generate();
    const rpc = installRpcMock({
      blockhash: Keypair.generate().publicKey.toBase58(),
      broadcastResult: null,
    });
    const review = await prepareWalletStandardReview({
      requestId: "request-3",
      payload: {
        chain: "solana",
        to: Keypair.generate().publicKey.toBase58(),
        amount: "1",
        providerId: "wallet-standard",
      },
      signerAddress: signer.publicKey.toBase58(),
      rpcUrl: "https://rpc.invalid",
      env,
    });
    const input = {
      requestId: review.requestId,
      preparedId: review.preparedId,
      intentDigest: review.intentDigest,
      signedTxBase64: sign(review.unsignedTxBase64, signer),
      rpcUrl: "https://rpc.invalid",
      env,
    };

    await expect(executeWalletStandardReview(input)).rejects.toMatchObject({
      code: "wallet_provider_ambiguous",
    });
    await expect(executeWalletStandardReview(input)).rejects.toMatchObject({
      code: "wallet_provider_ambiguous",
    });
    expect(rpc.methods.filter((method) => method === "sendTransaction")).toHaveLength(1);
  });
});
