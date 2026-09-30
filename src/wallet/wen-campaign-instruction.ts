import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { reviewWenCampaignAction } from "./wen-campaign-review.js";

export type CampaignPositionSnapshot = {
  address: string;
  accountOwner: string;
  executable: boolean;
  data: Uint8Array;
  lamports: bigint;
  rentLamports: bigint;
};

// Canonical reconstruction only. The snapshot must later come from the protected
// signer's pinned RPC reader; caller-supplied bytes confer no signing authority.
export function buildWenCampaignOwnerInstruction(
  input: unknown,
  snapshot: CampaignPositionSnapshot,
) {
  const review = reviewWenCampaignAction(input);
  const q = review.candidate;
  const program = new PublicKey(q.programId);
  const owner = new PublicKey(q.owner);
  const [mint] = PublicKey.findProgramAddressSync(
    [Buffer.from("wen-sat-mint-v1"), new PublicKey(q.economy).toBuffer()],
    program,
  );
  const [position] = PublicKey.findProgramAddressSync(
    [Buffer.from("wen-retail-position-v2"), owner.toBuffer(), mint.toBuffer()],
    program,
  );
  const b = Buffer.from(snapshot.data);
  const uint = (n: bigint) => typeof n === "bigint" && n >= 0n && n <= (1n << 64n) - 1n;
  if (
    snapshot.address !== q.position ||
    q.position !== position.toBase58() ||
    snapshot.accountOwner !== q.programId ||
    snapshot.executable ||
    b.length !== 256 ||
    b.subarray(0, 8).toString() !== "WENRPOS2" ||
    b[8] !== 1 ||
    b[9] !== 0 ||
    b.subarray(12, 16).some(Boolean) ||
    b[10] > 1 ||
    b[184] !== 0 ||
    [224, 225, 226].some((i) => b[i] > 1) ||
    !b.subarray(16, 48).equals(owner.toBuffer()) ||
    !b.subarray(80, 112).equals(mint.toBuffer()) ||
    !uint(snapshot.lamports) ||
    !uint(snapshot.rentLamports) ||
    snapshot.lamports < snapshot.rentLamports ||
    owner.equals(program) ||
    position.equals(program) ||
    owner.equals(position)
  ) {
    throw new Error("Invalid campaign position snapshot");
  }
  const amount = BigInt(q.amountLamports);
  const available = snapshot.lamports - snapshot.rentLamports;
  if (
    (q.operation === "withdraw" && amount > available) ||
    (q.operation === "top-up" && !uint(snapshot.lamports + amount))
  ) {
    throw new Error("Invalid campaign capital amount");
  }
  const keys = [
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: position, isSigner: false, isWritable: true },
  ];
  if (q.operation === "top-up") {
    keys.push({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false });
  }
  const data = Buffer.alloc(q.operation === "stop" ? 1 : 9);
  data[0] = review.opcode;
  if (data.length === 9) {
    data.writeBigUInt64LE(amount, 1);
  }
  return {
    instruction: new TransactionInstruction({ programId: program, keys, data }),
    availableLamports: available,
    signingEnabled: false as const,
    rpcAuthenticated: false as const,
  };
}
