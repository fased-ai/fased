import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  financialAgentReattachmentMessage,
  findFinancialAgentBindingForLocalAgent,
} from "./financial-agent-binding.js";

const mocks = vi.hoisted(() => ({
  fetchPinnedSolanaRpcRead: vi.fn(),
  release: vi.fn(async () => {}),
}));

vi.mock("../wallet/solana-rpc-read-fetch.js", () => ({
  fetchPinnedSolanaRpcRead: mocks.fetchPinnedSolanaRpcRead,
}));

const {
  FASED_AGENT_IDENTITY_PROGRAM_ID,
  issueFinalizedFinancialAgentReattachmentChallenge,
  readFinalizedFinancialAgent,
  reattachFinancialAgentFromFinalizedChain,
} = await import("./financial-agent-readback.js");

function account(data: Buffer, owner = FASED_AGENT_IDENTITY_PROGRAM_ID) {
  return { data: [data.toString("base64"), "base64"], executable: false, owner };
}

function recordFixture(authorities?: { controller: PublicKey; recovery: PublicKey }) {
  const founding = Keypair.generate().publicKey;
  const controller = authorities?.controller ?? Keypair.generate().publicKey;
  const recovery = authorities?.recovery ?? Keypair.generate().publicKey;
  const [record, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("fased-agent-record"), founding.toBuffer()],
    new PublicKey(FASED_AGENT_IDENTITY_PROGRAM_ID),
  );
  const data = Buffer.alloc(219);
  Buffer.from([164, 123, 4, 229, 103, 117, 40, 238]).copy(data, 0);
  data[8] = 1;
  data[9] = 0;
  data[10] = bump;
  data.writeBigUInt64LE(7n, 11);
  data.writeBigUInt64LE(100n, 19);
  data.writeBigInt64LE(1_788_350_400n, 27);
  founding.toBuffer().copy(data, 35);
  controller.toBuffer().copy(data, 67);
  recovery.toBuffer().copy(data, 99);
  return { data, record, controller, recovery };
}

function namespaceFixture(record: PublicKey, address: PublicKey): Buffer {
  const name = Buffer.from("Wally");
  const handle = Buffer.from("@wally");
  const ticker = Buffer.from("WALL");
  const data = Buffer.alloc(74 + 4 + name.length + 4 + handle.length + 4 + ticker.length + 32 + 48);
  Buffer.from([104, 123, 67, 82, 16, 144, 216, 189]).copy(data, 0);
  data[8] = 1;
  data[9] = PublicKey.findProgramAddressSync(
    [Buffer.from("namespace-binding"), record.toBuffer()],
    new PublicKey(FASED_AGENT_IDENTITY_PROGRAM_ID),
  )[1];
  record.toBuffer().copy(data, 10);
  Buffer.alloc(32, 9).copy(data, 42);
  let offset = 74;
  for (const value of [name, handle, ticker]) {
    data.writeUInt32LE(value.length, offset);
    offset += 4;
    value.copy(data, offset);
    offset += value.length;
  }
  Buffer.alloc(32, 4).copy(data, offset);
  offset += 32 + 8 + 8;
  data.writeBigUInt64LE(88n, offset);
  offset += 8 + 8;
  data.writeBigUInt64LE(7n, offset);
  offset += 8;
  data.writeBigUInt64LE(2n, offset);
  expect(address.toBase58()).toBeTruthy();
  return data;
}

function miningFixture(record: PublicKey): Buffer {
  const data = Buffer.alloc(234);
  Buffer.from([39, 109, 166, 142, 221, 165, 68, 23]).copy(data, 0);
  data[8] = 1;
  data[9] = PublicKey.findProgramAddressSync(
    [Buffer.from("mining-binding"), record.toBuffer()],
    new PublicKey(FASED_AGENT_IDENTITY_PROGRAM_ID),
  )[1];
  record.toBuffer().copy(data, 10);
  Keypair.generate().publicKey.toBuffer().copy(data, 42);
  new PublicKey("H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF") // pragma: allowlist secret
    .toBuffer()
    .copy(data, 74);
  Keypair.generate().publicKey.toBuffer().copy(data, 106);
  data.writeBigUInt64LE(99n, 218);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("finalized financial Agent readback", () => {
  it("derives and verifies the record plus optional namespace and Mining bindings", async () => {
    const fixture = recordFixture();
    const program = new PublicKey(FASED_AGENT_IDENTITY_PROGRAM_ID);
    const [namespace] = PublicKey.findProgramAddressSync(
      [Buffer.from("namespace-binding"), fixture.record.toBuffer()],
      program,
    );
    const [mining] = PublicKey.findProgramAddressSync(
      [Buffer.from("mining-binding"), fixture.record.toBuffer()],
      program,
    );
    const genesisHash = Keypair.generate().publicKey.toBase58();
    mocks.fetchPinnedSolanaRpcRead.mockImplementation(async ({ body }: { body: string }) => {
      const request = JSON.parse(body) as { method: string };
      return {
        response: new Response(
          JSON.stringify(
            request.method === "getGenesisHash"
              ? { jsonrpc: "2.0", result: genesisHash }
              : {
                  jsonrpc: "2.0",
                  result: {
                    context: { slot: 1234 },
                    value: [
                      account(fixture.data),
                      account(namespaceFixture(fixture.record, namespace)),
                      account(miningFixture(fixture.record)),
                    ],
                  },
                },
          ),
          { status: 200 },
        ),
        release: mocks.release,
      };
    });

    const result = await readFinalizedFinancialAgent({
      rpcUrl: "https://rpc.example.test",
      genesisHash,
      fasedAgentRecord: fixture.record.toBase58(),
    });

    expect(result).toEqual(
      expect.objectContaining({
        controller: fixture.controller.toBase58(),
        recoveryAuthority: fixture.recovery.toBase58(),
        authorityGeneration: "7",
        createdSlot: "100",
        createdUnixTimestamp: "1788350400",
        finalizedSlot: 1234,
        namespaceBinding: expect.objectContaining({
          address: namespace.toBase58(),
          name: "Wally",
          ticker: "WALL",
        }),
        miningBinding: expect.objectContaining({ address: mining.toBase58(), boundSlot: 99 }),
      }),
    );
    const body = JSON.parse(mocks.fetchPinnedSolanaRpcRead.mock.calls[1][0].body) as {
      params: unknown[];
    };
    expect(body.params[1]).toEqual({ commitment: "finalized", encoding: "base64" });
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it("rejects an account owned by another program", async () => {
    const fixture = recordFixture();
    const genesisHash = Keypair.generate().publicKey.toBase58();
    mocks.fetchPinnedSolanaRpcRead.mockImplementation(async ({ body }: { body: string }) => {
      const request = JSON.parse(body) as { method: string };
      return {
        response: new Response(
          JSON.stringify(
            request.method === "getGenesisHash"
              ? { jsonrpc: "2.0", result: genesisHash }
              : {
                  jsonrpc: "2.0",
                  result: {
                    context: { slot: 1 },
                    value: [
                      account(fixture.data, Keypair.generate().publicKey.toBase58()),
                      null,
                      null,
                    ],
                  },
                },
          ),
        ),
        release: mocks.release,
      };
    });

    await expect(
      readFinalizedFinancialAgent({
        rpcUrl: "https://rpc.example.test",
        genesisHash,
        fasedAgentRecord: fixture.record.toBase58(),
      }),
    ).rejects.toThrow("not an Agent-program data account");
  });

  it("rejects namespace bytes not consumed by the generated layout", async () => {
    const fixture = recordFixture();
    const program = new PublicKey(FASED_AGENT_IDENTITY_PROGRAM_ID);
    const [namespace] = PublicKey.findProgramAddressSync(
      [Buffer.from("namespace-binding"), fixture.record.toBuffer()],
      program,
    );
    const genesisHash = Keypair.generate().publicKey.toBase58();
    mocks.fetchPinnedSolanaRpcRead.mockImplementation(async ({ body }: { body: string }) => {
      const request = JSON.parse(body) as { method: string };
      const malformedNamespace = Buffer.concat([
        namespaceFixture(fixture.record, namespace),
        Buffer.from([0]),
      ]);
      return {
        response: new Response(
          JSON.stringify(
            request.method === "getGenesisHash"
              ? { jsonrpc: "2.0", result: genesisHash }
              : {
                  jsonrpc: "2.0",
                  result: {
                    context: { slot: 1 },
                    value: [account(fixture.data), account(malformedNamespace), null],
                  },
                },
          ),
        ),
        release: mocks.release,
      };
    });

    await expect(
      readFinalizedFinancialAgent({
        rpcUrl: "https://rpc.example.test",
        genesisHash,
        fasedAgentRecord: fixture.record.toBase58(),
      }),
    ).rejects.toThrow("trailing or truncated");
  });

  it("rejects an RPC from a different genesis before reading Agent accounts", async () => {
    const fixture = recordFixture();
    mocks.fetchPinnedSolanaRpcRead.mockResolvedValue({
      response: new Response(
        JSON.stringify({ jsonrpc: "2.0", result: Keypair.generate().publicKey.toBase58() }),
      ),
      release: mocks.release,
    });

    await expect(
      readFinalizedFinancialAgent({
        rpcUrl: "https://rpc.example.test",
        genesisHash: Keypair.generate().publicKey.toBase58(),
        fasedAgentRecord: fixture.record.toBase58(),
      }),
    ).rejects.toThrow("genesis hash does not match");
    expect(mocks.fetchPinnedSolanaRpcRead).toHaveBeenCalledOnce();
  });

  it("reattaches only through two finalized reads and a current authority signature", async () => {
    const keys = generateKeyPairSync("ed25519");
    const der = keys.publicKey.export({ type: "spki", format: "der" });
    const controller = new PublicKey(der.subarray(der.length - 32));
    const fixture = recordFixture({ controller, recovery: Keypair.generate().publicKey });
    const genesisHash = Keypair.generate().publicKey.toBase58();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-financial-readback-"));
    const env = { ...process.env, FASED_STATE_DIR: stateDir };
    mocks.fetchPinnedSolanaRpcRead.mockImplementation(async ({ body }: { body: string }) => {
      const request = JSON.parse(body) as { method: string };
      return {
        response: new Response(
          JSON.stringify(
            request.method === "getGenesisHash"
              ? { jsonrpc: "2.0", result: genesisHash }
              : {
                  jsonrpc: "2.0",
                  result: { context: { slot: 1234 }, value: [account(fixture.data), null, null] },
                },
          ),
        ),
        release: mocks.release,
      };
    });

    try {
      const challenge = await issueFinalizedFinancialAgentReattachmentChallenge({
        rpcUrl: "https://rpc.example.test",
        genesisHash,
        fasedAgentRecord: fixture.record.toBase58(),
        localAgentId: "restored-wally",
        env,
      });
      const signatureBase64 = sign(
        null,
        Buffer.from(financialAgentReattachmentMessage(challenge), "utf8"),
        keys.privateKey,
      ).toString("base64");
      const binding = await reattachFinancialAgentFromFinalizedChain({
        rpcUrl: "https://rpc.example.test",
        genesisHash,
        challenge,
        signer: controller.toBase58(),
        signatureBase64,
        env,
      });

      expect(binding.finalizedSlot).toBe(1234);
      expect(findFinancialAgentBindingForLocalAgent("restored-wally", env)?.controller).toBe(
        controller.toBase58(),
      );
      expect(mocks.fetchPinnedSolanaRpcRead).toHaveBeenCalledTimes(4);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
