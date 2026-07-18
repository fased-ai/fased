import { AddressLookupTableAccount, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { fetchSolanaRpc, SOLANA_ASSET_CONSTANTS } from "./solana-assets.js";
import { walletDiagnosticErrorString } from "./wallet-redaction.js";

const SOLANA_SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SOLANA_COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const SOLANA_ADDRESS_LOOKUP_TABLE_PROGRAM_ID = "AddressLookupTab1e1111111111111111111111111";
const SOLANA_ACTIVE_LOOKUP_TABLE_SLOT = 18_446_744_073_709_551_615n;
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
      writableAccounts: string[];
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
    value?: Array<{
      data?: [string, string] | string;
      owner?: string;
      executable?: boolean;
    } | null>;
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
    if (
      rows[index]?.owner !== SOLANA_ADDRESS_LOOKUP_TABLE_PROGRAM_ID ||
      rows[index]?.executable === true
    ) {
      throw new Error(`address lookup table has invalid owner/state: ${key.toBase58()}`);
    }
    const table = decodeAddressLookupTable(encoded, key);
    if (table.state.deactivationSlot !== SOLANA_ACTIVE_LOOKUP_TABLE_SLOT) {
      throw new Error(`address lookup table is deactivated: ${key.toBase58()}`);
    }
    return table;
  });
}

async function fetchTransactionAccountMetadata(params: {
  rpcUrl: string;
  keys: PublicKey[];
}): Promise<Array<{ owner?: string; executable: boolean } | null>> {
  if (params.keys.length === 0) {
    return [];
  }
  if (params.keys.length > 100) {
    throw new Error("transaction uses more than 100 accounts");
  }
  const result = await fetchSolanaRpc<{
    value?: Array<{ owner?: string; executable?: boolean } | null>;
  }>(params.rpcUrl, "getMultipleAccounts", [
    params.keys.map((key) => key.toBase58()),
    { encoding: "base64", dataSlice: { offset: 0, length: 0 } },
  ]);
  const rows = Array.isArray(result?.value) ? result.value : [];
  if (rows.length !== params.keys.length) {
    throw new Error("transaction account metadata response length mismatch");
  }
  return rows.map((row) =>
    row
      ? {
          owner: typeof row.owner === "string" ? row.owner : undefined,
          executable: true === row.executable,
        }
      : null,
  );
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
  expectedAdditionalSigners?: string[];
  rpcUrl?: string;
}): Promise<SolanaTransactionInspectionResult> {
  let tx: VersionedTransaction;
  try {
    const raw = Buffer.from(params.serializedTxBase64, "base64");
    if (raw.length === 0 || raw.length > 1_232) {
      throw new Error("serialized transaction is empty or exceeds Solana's 1232-byte limit");
    }
    tx = VersionedTransaction.deserialize(raw);
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

  let expectedAdditionalSigners: string[];
  try {
    expectedAdditionalSigners = unique(
      (params.expectedAdditionalSigners ?? []).map((value) => new PublicKey(value).toBase58()),
    );
  } catch {
    return {
      ok: false,
      code: "wallet_swap_signer_invalid",
      message: "an expected additional signer is not a valid Solana address",
    };
  }
  if (expectedAdditionalSigners.includes(expectedSigner)) {
    return {
      ok: false,
      code: "wallet_swap_signer_invalid",
      message: "the wallet signer cannot also be an additional signer",
    };
  }

  const signerKeys = tx.message.staticAccountKeys
    .slice(0, tx.message.header.numRequiredSignatures)
    .map((key) => key.toBase58());
  const exactSignerSet = new Set([expectedSigner, ...expectedAdditionalSigners]);
  if (
    signerKeys.length !== exactSignerSet.size ||
    !signerKeys.includes(expectedSigner) ||
    signerKeys.some((key) => !exactSignerSet.has(key)) ||
    expectedAdditionalSigners.some((key) => !signerKeys.includes(key))
  ) {
    return {
      ok: false,
      code: "wallet_swap_unexpected_signer",
      message: "transaction required signers do not exactly match the reviewed signer set",
    };
  }
  if (
    tx.signatures.length !== signerKeys.length ||
    tx.signatures.some((signature) => signature.some((byte) => byte !== 0))
  ) {
    return {
      ok: false,
      code: "wallet_swap_transaction_already_signed",
      message: "transaction must contain only empty signatures before signer review",
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
  const allAccountKeys = Array.from({ length: accountKeys.length }, (_, index) =>
    accountKeys.get(index),
  );
  if (allAccountKeys.some((key) => !key)) {
    return {
      ok: false,
      code: "wallet_swap_account_unresolved",
      message: "swap transaction contains an unresolved account",
    };
  }
  const resolvedAccountKeys = allAccountKeys as PublicKey[];
  let accountMetadata: Array<{ owner?: string; executable: boolean } | null> = [];
  if (!params.rpcUrl?.trim()) {
    return {
      ok: false,
      code: "wallet_swap_rpc_required",
      message: "Solana RPC is required for signer-owned transaction account validation",
    };
  }
  try {
    accountMetadata = await fetchTransactionAccountMetadata({
      rpcUrl: params.rpcUrl,
      keys: resolvedAccountKeys,
    });
  } catch (err) {
    return {
      ok: false,
      code: "wallet_swap_account_metadata_unavailable",
      message: walletDiagnosticErrorString(err),
    };
  }
  const programIds: string[] = [];
  const referencedIndexes = new Set<number>();
  for (const ix of tx.message.compiledInstructions) {
    referencedIndexes.add(ix.programIdIndex);
    for (const accountIndex of ix.accountKeyIndexes) {
      referencedIndexes.add(accountIndex);
    }
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
  for (const index of referencedIndexes) {
    if (accountMetadata[index]?.executable) {
      programIds.push(resolvedAccountKeys[index]?.toBase58() ?? "");
    }
  }
  const uniqueProgramIds = unique(programIds);
  const writableAccounts = resolvedAccountKeys
    .map((key, index) => (tx.message.isAccountWritable(index) ? key.toBase58() : ""))
    .filter(Boolean)
    .toSorted();
  return {
    ok: true,
    signer: expectedSigner,
    programIds: uniqueProgramIds,
    routeProgramIds: uniqueProgramIds.filter((programId) => !isCommonProgram(programId)),
    writableAccounts,
    usesAddressLookupTables: lookupKeys.length > 0,
  };
}
