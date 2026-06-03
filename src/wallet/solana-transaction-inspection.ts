import { AddressLookupTableAccount, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { fetchSolanaRpc, SOLANA_ASSET_CONSTANTS } from "./solana-assets.js";
import { walletDiagnosticErrorString } from "./wallet-redaction.js";

const SOLANA_SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SOLANA_COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const SOLANA_MEMO_PROGRAM_IDS = new Set([
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);
const KNOWN_JUPITER_PROGRAM_IDS = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
]);
const BLOCKED_PROGRAM_IDS = new Set([
  "BPFLoader1111111111111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "Config1111111111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
]);

export type SolanaTransactionInspectionResult =
  | {
      ok: true;
      signer: string;
      programIds: string[];
      routeProgramIds: string[];
      usesAddressLookupTables: boolean;
    }
  | { ok: false; code: string; message: string };

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function decodeAddressLookupTable(dataBase64: string, key: PublicKey): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key,
    state: AddressLookupTableAccount.deserialize(Buffer.from(dataBase64, "base64")),
  });
}

async function fetchAddressLookupTables(params: {
  rpcUrl: string;
  keys: PublicKey[];
}): Promise<AddressLookupTableAccount[]> {
  if (params.keys.length === 0) {
    return [];
  }
  const result = await fetchSolanaRpc<{
    value?: Array<{ data?: [string, string] | string } | null>;
  }>(params.rpcUrl, "getMultipleAccounts", [
    params.keys.map((key) => key.toBase58()),
    { encoding: "base64" },
  ]);
  const rows = Array.isArray(result?.value) ? result?.value : [];
  return params.keys.map((key, index) => {
    const data = rows[index]?.data;
    const encoded = Array.isArray(data) ? data[0] : typeof data === "string" ? data : "";
    if (!encoded) {
      throw new Error(`address lookup table unavailable: ${key.toBase58()}`);
    }
    return decodeAddressLookupTable(encoded, key);
  });
}

function isCommonProgram(programId: string): boolean {
  return (
    programId === SOLANA_SYSTEM_PROGRAM_ID ||
    programId === SOLANA_ASSET_CONSTANTS.tokenProgramId ||
    programId === SOLANA_ASSET_CONSTANTS.token2022ProgramId ||
    programId === SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID ||
    programId === SOLANA_COMPUTE_BUDGET_PROGRAM_ID ||
    SOLANA_MEMO_PROGRAM_IDS.has(programId) ||
    KNOWN_JUPITER_PROGRAM_IDS.has(programId)
  );
}

export async function inspectSerializedSolanaSwapTransaction(params: {
  serializedTxBase64: string;
  expectedSigner: string;
  rpcUrl?: string;
}): Promise<SolanaTransactionInspectionResult> {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(params.serializedTxBase64, "base64"));
  } catch (err) {
    return {
      ok: false,
      code: "wallet_swap_transaction_invalid",
      message: `failed to decode Solana transaction: ${walletDiagnosticErrorString(err)}`,
    };
  }
  let expectedSigner: string;
  try {
    expectedSigner = new PublicKey(params.expectedSigner).toBase58();
  } catch {
    return {
      ok: false,
      code: "wallet_swap_signer_invalid",
      message: "expected signer is not a valid Solana address",
    };
  }

  const signerKeys = tx.message.staticAccountKeys
    .slice(0, tx.message.header.numRequiredSignatures)
    .map((key) => key.toBase58());
  if (signerKeys.length !== 1 || signerKeys[0] !== expectedSigner) {
    return {
      ok: false,
      code: "wallet_swap_unexpected_signer",
      message: "swap transaction requires an unexpected signer",
    };
  }

  let lookupTables: AddressLookupTableAccount[] = [];
  const lookupKeys = tx.message.addressTableLookups.map((lookup) => lookup.accountKey);
  if (lookupKeys.length > 0) {
    if (!params.rpcUrl?.trim()) {
      return {
        ok: false,
        code: "wallet_swap_lookup_rpc_required",
        message:
          "swap transaction uses address lookup tables; Solana RPC is required to inspect it",
      };
    }
    try {
      lookupTables = await fetchAddressLookupTables({
        rpcUrl: params.rpcUrl,
        keys: lookupKeys,
      });
    } catch (err) {
      return {
        ok: false,
        code: "wallet_swap_lookup_unavailable",
        message: walletDiagnosticErrorString(err),
      };
    }
  }

  const accountKeys = tx.message.getAccountKeys({
    addressLookupTableAccounts: lookupTables,
  });
  const programIds: string[] = [];
  for (const ix of tx.message.compiledInstructions) {
    const programId = accountKeys.get(ix.programIdIndex)?.toBase58();
    if (!programId) {
      return {
        ok: false,
        code: "wallet_swap_program_unresolved",
        message: "swap transaction contains an unresolved program id",
      };
    }
    if (BLOCKED_PROGRAM_IDS.has(programId)) {
      return {
        ok: false,
        code: "wallet_swap_program_blocked",
        message: `swap transaction uses blocked program ${programId}`,
      };
    }
    programIds.push(programId);
  }
  const uniqueProgramIds = unique(programIds);
  return {
    ok: true,
    signer: expectedSigner,
    programIds: uniqueProgramIds,
    routeProgramIds: uniqueProgramIds.filter((programId) => !isCommonProgram(programId)),
    usesAddressLookupTables: lookupKeys.length > 0,
  };
}
