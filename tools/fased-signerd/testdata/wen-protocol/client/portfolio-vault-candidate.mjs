// Unsigned candidate codec only. No RPC, deployment admission, signing or sending.
const SYSTEM = "11111111111111111111111111111111";
const u64 = (n) => {
  if (typeof n !== "bigint" || n < 0n || n > 0xffffffffffffffffn) {
    throw Error("invalid vault integer");
  }
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
export async function derivePortfolioVaultCandidate(sdk, identity, operation, args = {}) {
  const id = structuredClone(identity),
    r = structuredClone(args),
    enc = sdk.getAddressEncoder();
  for (const name of ["program", "owner", "id", "recipient"]) {
    sdk.assertIsAddress(id[name]);
  }
  const [vault] = await sdk.getProgramDerivedAddress({
    programAddress: id.program,
    seeds: ["wen-portfolio-sol-v1", enc.encode(id.owner), enc.encode(id.id)],
  });
  const action = async () =>
    (
      await sdk.getProgramDerivedAddress({
        programAddress: id.program,
        seeds: ["wen-portfolio-action-v1", enc.encode(vault), u64(r.nonce)],
      })
    )[0];
  const m = (address, isSigner = false, isWritable = false) => ({ address, isSigner, isWritable });
  const mining = async () => {
    sdk.assertIsAddress(id.sale);
    return Promise.all(
      ["wen-mining-budget-v1", "wen-mining-capital-v1"].map((seed) =>
        sdk
          .getProgramDerivedAddress({
            programAddress: id.program,
            seeds: [seed, enc.encode(id.sale), enc.encode(id.owner)],
          })
          .then(([key]) => key),
      ),
    );
  };
  let data, accounts;
  switch (operation) {
    case "initialize":
      data = [113, ...enc.encode(id.id), ...u64(r.limit)];
      accounts = [m(id.owner, true, true), m(vault, false, true), m(id.recipient), m(SYSTEM)];
      break;
    case "deposit":
    case "withdraw":
      if (r.amount === 0n) {
        throw Error("zero vault capital");
      }
      data = [114, operation === "deposit" ? 1 : 0, ...u64(r.amount)];
      accounts = [m(id.owner, true, true), m(vault, false, true), m(SYSTEM)];
      break;
    case "configure":
      if (typeof r.enabled !== "boolean") {
        throw Error("invalid enabled flag");
      }
      data = [115, ...u64(r.revision), ...u64(r.limit), r.enabled ? 1 : 0];
      accounts = [m(id.owner, true), m(vault, false, true)];
      break;
    case "reserve":
      if (
        r.amount === 0n ||
        typeof r.expires !== "bigint" ||
        r.expires <= 0n ||
        r.expires > 0x7fffffffffffffffn
      ) {
        throw Error("invalid reservation bounds");
      }
      data = [116, ...u64(r.nonce), ...u64(r.amount), ...u64(r.expires), ...u64(r.revision)];
      accounts = [
        m(id.owner, true, true),
        m(vault, false, true),
        m(await action(), false, true),
        m(SYSTEM),
      ];
      break;
    case "pay":
      data = [117];
      accounts = [
        m(vault, false, true),
        m(await action(), false, true),
        m(id.recipient, false, true),
      ];
      break;
    case "expire":
      data = [118];
      accounts = [m(vault, false, true), m(await action(), false, true)];
      break;
    case "initializeMining": {
      const [budget, capital] = await mining();
      data = [119, ...enc.encode(id.id), ...u64(r.limit)];
      accounts = [
        m(id.owner, true, true),
        m(vault, false, true),
        m(id.sale),
        m(budget),
        m(capital),
        m(SYSTEM),
      ];
      break;
    }
    case "fundMining": {
      const [budget, capital] = await mining();
      data = [120];
      accounts = [
        m(vault, false, true),
        m(await action(), false, true),
        m(id.owner),
        m(id.sale),
        m(budget),
        m(capital, false, true),
      ];
      break;
    }
    default:
      throw Error("unsupported portfolio vault candidate operation");
  }
  if (new Set(accounts.map((a) => a.address)).size !== accounts.length) {
    throw Error("aliased vault accounts");
  }
  return Object.freeze({
    scope: "unsigned-portfolio-vault-candidate",
    signingEnabled: false,
    publicEntryEnabled: false,
    vault,
    instruction: { programAddress: id.program, data: Uint8Array.from(data), accounts },
  });
}
