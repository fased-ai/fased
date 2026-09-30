import { quoteClaimCosts } from "./claim-costs.mjs";
import { createOwnerSession } from "./contribution-session.mjs";
import { createInventoryClaimReader } from "./inventory-claim-rpc.mjs";
import { claimComputeInstruction } from "./staking-claim-compute.mjs";
import { createNativeClaimReader } from "./staking-claim-rpc.mjs";
export const quoteNativeClaimCosts = (args) => quoteClaimCosts({ ...args, receiptBytes: 112 });
export const compileNativeClaim = (args) => compileSatClaim(args, false);
export const compileInventoryClaim = (args) => compileSatClaim(args, true);
function compileSatClaim(
  { sdk, prepared, owner, program, blockhash, lastValidBlockHeight, currentBlockHeight },
  stock,
) {
  const i = structuredClone(prepared?.instruction),
    enc = sdk.getAddressEncoder(),
    hex = (a) => Array.from(enc.encode(a), (b) => b.toString(16).padStart(2, "0")).join("");
  const awardVersion = stock ? (prepared.awardVersion ?? 1) : 1,
    count = stock && awardVersion === 2 ? 15 : 13;
  if (![1, 2].includes(awardVersion)) {
    throw Error("invalid claim award version");
  }
  if (
    !i ||
    hex(i.programAddress) !== program ||
    !(i.data instanceof Uint8Array) ||
    i.data.length !== (stock ? 57 : 17) ||
    i.data[0] !== (stock ? 103 : 42) ||
    !Array.isArray(i.accounts) ||
    i.accounts.length !== count ||
    hex(i.accounts[0].address) !== owner ||
    i.accounts.some(
      (a, n) =>
        a.isSigner !== (n === 0) ||
        a.isWritable !== (stock ? [0, 3, 4, 7, 8, 9, 13, 14] : [0, 4, 7, 8, 9]).includes(n),
    ) ||
    new Set(i.accounts.map((a) => a.address)).size !== count
  ) {
    throw new Error("invalid native claim envelope");
  }
  for (const a of i.accounts) {
    sdk.assertIsAddress(a.address);
  }
  if (
    ![lastValidBlockHeight, currentBlockHeight].every((n) => typeof n === "bigint" && n >= 0n) ||
    lastValidBlockHeight <= currentBlockHeight
  ) {
    throw new Error("expired claim lifetime");
  }
  sdk.assertIsBlockhash(blockhash);
  let message = sdk.createTransactionMessage({ version: 0 });
  message = sdk.setTransactionMessageFeePayer(i.accounts[0].address, message);
  message = sdk.setTransactionMessageLifetimeUsingBlockhash(
    { blockhash, lastValidBlockHeight },
    message,
  );
  message = sdk.appendTransactionMessageInstruction(claimComputeInstruction(), message);
  message = sdk.appendTransactionMessageInstruction(
    {
      programAddress: i.programAddress,
      data: i.data,
      accounts: i.accounts.map((a) => ({
        address: a.address,
        role: (a.isSigner ? 2 : 0) + (a.isWritable ? 1 : 0),
      })),
    },
    message,
  );
  const transaction = sdk.compileTransaction(message),
    wire = Uint8Array.from(sdk.getTransactionEncoder().encode(transaction));
  if (
    wire.length > 1232 ||
    Object.keys(transaction.signatures).length !== 1 ||
    !(i.accounts[0].address in transaction.signatures)
  ) {
    throw new Error("invalid claim signers or size");
  }
  return { transaction, wire };
}
export const createNativeClaimSession = (config) => createSatClaimSession(config, false);
export const createInventoryClaimSession = (config) => createSatClaimSession(config, true);
function createSatClaimSession(config, stock) {
  const identity = structuredClone(config.identity),
    sdk = config.sdk,
    genesis = config.genesis;
  const enc = sdk.getAddressEncoder(),
    hex = (a) => Array.from(enc.encode(a), (b) => b.toString(16).padStart(2, "0")).join("");
  const awardVersion = config.awardVersion ?? 1;
  if (stock && ![1, 2].includes(awardVersion)) {
    throw Error("invalid inventory award version");
  }
  const reader = (stock ? createInventoryClaimReader : createNativeClaimReader)({
    ...config,
    identity,
  });
  const maxTotalCostLamports = config.maxTotalCostLamports,
    maxSlotLag = config.maxSlotLag ?? 32n;
  if (
    typeof maxTotalCostLamports !== "bigint" ||
    maxTotalCostLamports < 0n ||
    maxTotalCostLamports > 0xffffffffffffffffn
  ) {
    throw new Error("explicit total claim cost limit required");
  }
  const periods = (t) =>
    stock
      ? { source: t.source, epoch: t.epoch, cohort: t.cohort, inventoryVersion: t.inventoryVersion }
      : { award: t.award };
  const session = createOwnerSession({
    ...config,
    recoveryRecord: (t) => ({
      kind: stock ? "inventory-claim-effects-v1" : "native-claim-effects-v1",
      sale: identity.sale,
      destination: identity.destination,
      ...(stock
        ? {
            source: t.source,
            epoch: t.epoch.toString(),
            cohort: t.cohort.toString(),
            inventoryVersion: t.inventoryVersion,
            awardVersion: t.awardVersion,
          }
        : { award: t.award.toString() }),
      from: t.from.toString(),
      gross: t.gross.toString(),
      net: t.net.toString(),
      rentLamports: t.rentLamports.toString(),
      maxFeeLamports: config.maxFeeLamports.toString(),
    }),
    compile: stock ? compileInventoryClaim : compileNativeClaim,
    quoteCosts: (args) =>
      quoteNativeClaimCosts({
        ...args,
        rpc: config.rpc,
        owner: identity.owner,
        maxTotalCostLamports,
        maxSlotLag,
      }),
    planner: async (intent) => {
      const quote = await reader({
        ...periods(intent),
        from: intent.from,
        minSlot: intent.minSlot,
      });
      if (stock && quote.awardVersion !== awardVersion) {
        throw Error("inventory award descriptor version mismatch");
      }
      return quote;
    },
    describe: (intent, quote) => ({
      owner: intent.accounts.owner,
      program: intent.program,
      kind: stock ? "inventory-staking-claim" : "native-staking-claim",
      ...periods(intent),
      ...(stock ? { awardVersion: quote.awardVersion } : {}),
      from: intent.from,
      destination: identity.destination,
      gross: quote.gross,
      fee: quote.fee,
      net: quote.net,
    }),
  });
  return {
    ...session,
    prepare: (input) =>
      session.prepare(
        {
          ...periods(input),
          from: input.from,
          minSlot: input.minSlot,
          program: hex(identity.program),
          accounts: { owner: hex(identity.owner) },
        },
        { genesis },
      ),
  };
}
