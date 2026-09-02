import { PublicKey } from "@solana/web3.js";
import { fetchPinnedSolanaRpcRead } from "../wallet/solana-rpc-read-fetch.js";
import {
  FASED_AGENT_APPROVED_SATCOIN_PROGRAM_IDS,
  FASED_AGENT_IDENTITY_PROGRAM_ID,
  FASED_AGENT_MINING_LAYOUT,
  FASED_AGENT_NAMESPACE_LAYOUT,
  FASED_AGENT_RECORD_LAYOUT,
} from "./fased-agent-identity-contract.generated.js";
import type {
  FinalizedAgentMiningBinding,
  FinalizedAgentNamespaceBinding,
  FinalizedFinancialAgentReadback,
} from "./financial-agent-binding.js";
import {
  attachFinancialAgentFromFinalizedReadback,
  issueFinancialAgentReattachmentChallenge,
  type FinancialAgentBinding,
  type FinancialAgentReattachmentChallenge,
} from "./financial-agent-binding.js";

export { FASED_AGENT_IDENTITY_PROGRAM_ID };

type RpcAccount = { data?: [string, string]; executable?: boolean; owner?: string };
type RpcMultipleAccounts = { context?: { slot?: number }; value?: Array<RpcAccount | null> };
type RpcEnvelope = { error?: { message?: string }; result?: RpcMultipleAccounts };

function readU64(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

function readAddress(data: Buffer, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

function requireAccountData(account: RpcAccount, address: string, expectedSize?: number): Buffer {
  if (account.executable || account.owner !== FASED_AGENT_IDENTITY_PROGRAM_ID) {
    throw new Error(`${address} is not an Agent-program data account`);
  }
  if (!Array.isArray(account.data) || account.data[1] !== "base64") {
    throw new Error(`${address} did not return canonical base64 account data`);
  }
  const data = Buffer.from(account.data[0], "base64");
  if (expectedSize !== undefined && data.length !== expectedSize) {
    throw new Error(`${address} has unexpected account length ${data.length}`);
  }
  return data;
}

function readString(
  data: Buffer,
  cursor: { offset: number },
  maxBytes: number,
  label: string,
): string {
  if (cursor.offset + 4 > data.length) {
    throw new Error(`${label} length is truncated`);
  }
  const length = data.readUInt32LE(cursor.offset);
  cursor.offset += 4;
  if (length > maxBytes || cursor.offset + length > data.length) {
    throw new Error(`${label} exceeds its bounded layout`);
  }
  const value = data.subarray(cursor.offset, cursor.offset + length).toString("utf8");
  cursor.offset += length;
  if (Buffer.byteLength(value, "utf8") !== length || !value.trim()) {
    throw new Error(`${label} is not canonical UTF-8 text`);
  }
  return value;
}

function decodeRecord(params: { address: string; account: RpcAccount; finalizedSlot: number }) {
  const data = requireAccountData(params.account, params.address, FASED_AGENT_RECORD_LAYOUT.size);
  if (
    !data.subarray(0, 8).equals(Buffer.from(FASED_AGENT_RECORD_LAYOUT.discriminator)) ||
    data[8] !== FASED_AGENT_RECORD_LAYOUT.version
  ) {
    throw new Error("FasedAgentRecord discriminator/version mismatch");
  }
  const status = data[9] === 0 ? "active" : data[9] === 1 ? "retired" : null;
  if (!status) {
    throw new Error("FasedAgentRecord status is invalid");
  }
  const authorityGeneration = readU64(data, 11).toString();
  const foundingController = readAddress(data, 35);
  const [expectedAddress, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from(FASED_AGENT_RECORD_LAYOUT.seed), new PublicKey(foundingController).toBuffer()],
    new PublicKey(FASED_AGENT_IDENTITY_PROGRAM_ID),
  );
  if (expectedAddress.toBase58() !== params.address || bump !== data[10]) {
    throw new Error("FasedAgentRecord PDA/bump does not match its founding controller");
  }
  return {
    status,
    controller: readAddress(data, 67),
    recoveryAuthority: readAddress(data, 99),
    authorityGeneration,
    createdSlot: readU64(data, 19).toString(),
    createdUnixTimestamp: data.readBigInt64LE(27).toString(),
    finalizedSlot: params.finalizedSlot,
  } as const;
}

function decodeNamespace(params: {
  address: string;
  account: RpcAccount;
  fasedAgentRecord: string;
}): FinalizedAgentNamespaceBinding {
  const data = requireAccountData(params.account, params.address);
  if (
    !data.subarray(0, 8).equals(Buffer.from(FASED_AGENT_NAMESPACE_LAYOUT.discriminator)) ||
    data[8] !== FASED_AGENT_NAMESPACE_LAYOUT.version
  ) {
    throw new Error("AgentNamespaceBinding discriminator/version mismatch");
  }
  if (readAddress(data, 10) !== params.fasedAgentRecord) {
    throw new Error("AgentNamespaceBinding belongs to another Agent record");
  }
  const expectedBump = PublicKey.findProgramAddressSync(
    [
      Buffer.from(FASED_AGENT_NAMESPACE_LAYOUT.seed),
      new PublicKey(params.fasedAgentRecord).toBuffer(),
    ],
    new PublicKey(FASED_AGENT_IDENTITY_PROGRAM_ID),
  )[1];
  if (data[9] !== expectedBump) {
    throw new Error("AgentNamespaceBinding bump is invalid");
  }
  const cursor = { offset: 74 };
  const networkAgentId = data.subarray(42, 74).toString("hex");
  const name = readString(data, cursor, FASED_AGENT_NAMESPACE_LAYOUT.maxNameBytes, "Agent name");
  const handle = readString(
    data,
    cursor,
    FASED_AGENT_NAMESPACE_LAYOUT.maxHandleBytes,
    "Agent handle",
  );
  const ticker = readString(
    data,
    cursor,
    FASED_AGENT_NAMESPACE_LAYOUT.maxTickerBytes,
    "Agent ticker",
  );
  cursor.offset += 32 + 8 + 8;
  const boundSlot = Number(readU64(data, cursor.offset));
  cursor.offset += 8 + 8;
  const recordAuthorityGeneration = readU64(data, cursor.offset).toString();
  cursor.offset += 8;
  readU64(data, cursor.offset);
  cursor.offset += 8;
  if (cursor.offset !== data.length) {
    throw new Error("AgentNamespaceBinding has trailing or truncated account data");
  }
  if (!Number.isSafeInteger(boundSlot)) {
    throw new Error("AgentNamespaceBinding slot exceeds safe local representation");
  }
  return {
    address: params.address,
    networkAgentId,
    name,
    handle,
    ticker,
    boundSlot,
    recordAuthorityGeneration,
  };
}

function decodeMining(params: {
  address: string;
  account: RpcAccount;
  fasedAgentRecord: string;
}): FinalizedAgentMiningBinding {
  const data = requireAccountData(params.account, params.address, FASED_AGENT_MINING_LAYOUT.size);
  if (
    !data.subarray(0, 8).equals(Buffer.from(FASED_AGENT_MINING_LAYOUT.discriminator)) ||
    data[8] !== FASED_AGENT_MINING_LAYOUT.version
  ) {
    throw new Error("AgentMiningBinding discriminator/version mismatch");
  }
  if (readAddress(data, 10) !== params.fasedAgentRecord) {
    throw new Error("AgentMiningBinding belongs to another Agent record");
  }
  const expectedBump = PublicKey.findProgramAddressSync(
    [
      Buffer.from(FASED_AGENT_MINING_LAYOUT.seed),
      new PublicKey(params.fasedAgentRecord).toBuffer(),
    ],
    new PublicKey(FASED_AGENT_IDENTITY_PROGRAM_ID),
  )[1];
  if (data[9] !== expectedBump) {
    throw new Error("AgentMiningBinding bump is invalid");
  }
  const boundSlot = Number(readU64(data, 218));
  if (!Number.isSafeInteger(boundSlot)) {
    throw new Error("AgentMiningBinding slot exceeds safe local representation");
  }
  const satcoinProgramId = readAddress(data, 74);
  if (!FASED_AGENT_APPROVED_SATCOIN_PROGRAM_IDS.has(satcoinProgramId)) {
    throw new Error("AgentMiningBinding references an unapproved Satcoin program");
  }
  return {
    address: params.address,
    satAgentRecord: readAddress(data, 42),
    satcoinProgramId,
    permanentMiningId: readAddress(data, 106),
    boundSlot,
  };
}

async function fetchRpcEnvelope(rpcUrl: string, addresses: string[]): Promise<RpcEnvelope> {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getMultipleAccounts",
    params: [addresses, { commitment: "finalized", encoding: "base64" }],
  });
  const { response, release } = await fetchPinnedSolanaRpcRead({
    rpcUrl,
    body: request,
    timeoutMs: 10_000,
  });
  try {
    if (!response.ok) {
      throw new Error(`Agent account readback failed with HTTP ${response.status}`);
    }
    return (await response.json()) as RpcEnvelope;
  } finally {
    await release();
  }
}

async function readRpcGenesisHash(rpcUrl: string): Promise<string> {
  const { response, release } = await fetchPinnedSolanaRpcRead({
    rpcUrl,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
    timeoutMs: 10_000,
  });
  try {
    if (!response.ok) {
      throw new Error(`Agent genesis readback failed with HTTP ${response.status}`);
    }
    const envelope = (await response.json()) as {
      error?: { message?: string };
      result?: unknown;
    };
    if (envelope.error || typeof envelope.result !== "string") {
      throw new Error(`Agent genesis readback failed: ${envelope.error?.message ?? "RPC error"}`);
    }
    return new PublicKey(envelope.result).toBase58();
  } finally {
    await release();
  }
}

export async function readFinalizedFinancialAgent(params: {
  rpcUrl: string;
  genesisHash: string;
  fasedAgentRecord: string;
}): Promise<FinalizedFinancialAgentReadback> {
  const recordAddress = new PublicKey(params.fasedAgentRecord).toBase58();
  const expectedGenesisHash = new PublicKey(params.genesisHash).toBase58();
  const observedGenesisHash = await readRpcGenesisHash(params.rpcUrl);
  if (observedGenesisHash !== expectedGenesisHash) {
    throw new Error("Agent RPC genesis hash does not match the selected RPC profile");
  }
  const program = new PublicKey(FASED_AGENT_IDENTITY_PROGRAM_ID);
  const [namespaceAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from(FASED_AGENT_NAMESPACE_LAYOUT.seed), new PublicKey(recordAddress).toBuffer()],
    program,
  );
  const [miningAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from(FASED_AGENT_MINING_LAYOUT.seed), new PublicKey(recordAddress).toBuffer()],
    program,
  );
  const addresses = [recordAddress, namespaceAddress.toBase58(), miningAddress.toBase58()];
  const envelope = await fetchRpcEnvelope(params.rpcUrl, addresses);
  if (envelope.error) {
    throw new Error(`Agent finalized readback failed: ${envelope.error.message ?? "RPC error"}`);
  }
  const finalizedSlot = envelope.result?.context?.slot;
  const values = envelope.result?.value;
  if (!Number.isSafeInteger(finalizedSlot) || !Array.isArray(values) || values.length !== 3) {
    throw new Error("Agent finalized readback returned an invalid RPC envelope");
  }
  if (!values[0]) {
    throw new Error("FasedAgentRecord does not exist at finalized commitment");
  }
  const record = decodeRecord({
    address: recordAddress,
    account: values[0],
    finalizedSlot: finalizedSlot as number,
  });
  return {
    programId: FASED_AGENT_IDENTITY_PROGRAM_ID,
    genesisHash: observedGenesisHash,
    fasedAgentRecord: recordAddress,
    ...record,
    ...(values[1]
      ? {
          namespaceBinding: decodeNamespace({
            address: addresses[1],
            account: values[1],
            fasedAgentRecord: recordAddress,
          }),
        }
      : {}),
    ...(values[2]
      ? {
          miningBinding: decodeMining({
            address: addresses[2],
            account: values[2],
            fasedAgentRecord: recordAddress,
          }),
        }
      : {}),
  };
}

/**
 * Issue a challenge bound to the current finalized authority generation. The
 * caller must still perform a second finalized read when consuming it because
 * either authority may rotate between issuance and signature submission.
 */
export async function issueFinalizedFinancialAgentReattachmentChallenge(params: {
  rpcUrl: string;
  genesisHash: string;
  fasedAgentRecord: string;
  localAgentId: string;
  ttlMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<FinancialAgentReattachmentChallenge> {
  const readback = await readFinalizedFinancialAgent(params);
  return issueFinancialAgentReattachmentChallenge({
    fasedAgentRecord: readback.fasedAgentRecord,
    localAgentId: params.localAgentId,
    authorityGeneration: readback.authorityGeneration,
    ...(params.ttlMs === undefined ? {} : { ttlMs: params.ttlMs }),
    ...(params.env === undefined ? {} : { env: params.env }),
  });
}

/**
 * Reattach only after a fresh finalized read. This is the production entry
 * point; a cached or caller-authored Agent record is never sufficient.
 */
export async function reattachFinancialAgentFromFinalizedChain(params: {
  rpcUrl: string;
  genesisHash: string;
  challenge: FinancialAgentReattachmentChallenge;
  signer: string;
  signatureBase64: string;
  env?: NodeJS.ProcessEnv;
}): Promise<FinancialAgentBinding> {
  const readback = await readFinalizedFinancialAgent({
    rpcUrl: params.rpcUrl,
    genesisHash: params.genesisHash,
    fasedAgentRecord: params.challenge.fasedAgentRecord,
  });
  return attachFinancialAgentFromFinalizedReadback({
    readback,
    challenge: params.challenge,
    signer: params.signer,
    signatureBase64: params.signatureBase64,
    ...(params.env === undefined ? {} : { env: params.env }),
  });
}
