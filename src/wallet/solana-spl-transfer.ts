import { SOLANA_ASSET_CONSTANTS } from "./solana-assets.js";

const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TRANSFER_CHECKED_INSTRUCTION = 12;
const CREATE_ASSOCIATED_TOKEN_IDEMPOTENT_INSTRUCTION = 1;

export type SolanaInstructionKey = {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
};

export type SolanaInstructionEnvelope = {
  programId: string;
  dataBase64: string;
  keys: SolanaInstructionKey[];
};

type SolanaModuleLike = typeof import("@solana/web3.js");

let solanaWeb3Promise: Promise<SolanaModuleLike> | null = null;

async function loadSolanaWeb3(): Promise<SolanaModuleLike> {
  solanaWeb3Promise ??= import("@solana/web3.js");
  return await solanaWeb3Promise;
}

function u64Le(value: string): Buffer {
  const raw = BigInt(value);
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(raw);
  return out;
}

export async function deriveAssociatedTokenAddress(params: {
  owner: string;
  mint: string;
  tokenProgramId?: string;
}): Promise<string> {
  const solana = await loadSolanaWeb3();
  const tokenProgramId = params.tokenProgramId || SOLANA_ASSET_CONSTANTS.tokenProgramId;
  const [address] = solana.PublicKey.findProgramAddressSync(
    [
      new solana.PublicKey(params.owner).toBuffer(),
      new solana.PublicKey(tokenProgramId).toBuffer(),
      new solana.PublicKey(params.mint).toBuffer(),
    ],
    new solana.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  );
  return address.toBase58();
}

export async function buildCreateAssociatedTokenAccountIdempotentInstruction(params: {
  payer: string;
  owner: string;
  mint: string;
  tokenProgramId?: string;
}): Promise<SolanaInstructionEnvelope> {
  const tokenProgramId = params.tokenProgramId || SOLANA_ASSET_CONSTANTS.tokenProgramId;
  const associatedTokenAddress = await deriveAssociatedTokenAddress({
    owner: params.owner,
    mint: params.mint,
    tokenProgramId,
  });
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    dataBase64: Buffer.from([CREATE_ASSOCIATED_TOKEN_IDEMPOTENT_INSTRUCTION]).toString("base64"),
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
  };
}

export function buildTransferCheckedInstruction(params: {
  sourceTokenAccount: string;
  mint: string;
  destinationTokenAccount: string;
  authority: string;
  amountRaw: string;
  decimals: number;
  tokenProgramId?: string;
}): SolanaInstructionEnvelope {
  const data = Buffer.concat([
    Buffer.from([TRANSFER_CHECKED_INSTRUCTION]),
    u64Le(params.amountRaw),
    Buffer.from([Math.max(0, Math.floor(params.decimals))]),
  ]);
  return {
    programId: params.tokenProgramId || SOLANA_ASSET_CONSTANTS.tokenProgramId,
    dataBase64: data.toString("base64"),
    keys: [
      { pubkey: params.sourceTokenAccount, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.destinationTokenAccount, isSigner: false, isWritable: true },
      { pubkey: params.authority, isSigner: true, isWritable: false },
    ],
  };
}

export async function toTransactionInstruction(
  envelope: SolanaInstructionEnvelope,
): Promise<InstanceType<SolanaModuleLike["TransactionInstruction"]>> {
  const solana = await loadSolanaWeb3();
  return new solana.TransactionInstruction({
    programId: new solana.PublicKey(envelope.programId),
    data: Buffer.from(envelope.dataBase64, "base64"),
    keys: envelope.keys.map((key) => ({
      pubkey: new solana.PublicKey(key.pubkey),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
  });
}
