import { applyCampaignAccountingContext } from "./campaign-accounting-rpc.mjs";
import { validCampaignWindowFlags } from "./campaign-retail.mjs";
import { encodeCampaignCandidate } from "./campaign-retail.mjs";
const uint = (n) => typeof n === "bigint" && n >= 0n && n <= 0xffffffffffffffffn;
// Initial position creation and durable standing enrollment, unsigned only.
// Enrollment affects future frozen cohorts, never an already-open membership set.
async function buildCampaignSetupInstructionBase(sdk, input, atomic = false) {
  if (input?.op === 161) {
    const create = await buildCampaignSetupInstructionBase(sdk, { ...input, op: 132 }, true);
    const data = Array.from({ length: 256 }, () => 0);
    data.splice(0, 8, ...new TextEncoder().encode("WENRPOS2"));
    data[8] = 1;
    data[10] = 1;
    data[226] = 1;
    for (const [offset, key] of [
      [16, input.owner],
      [48, input.issuer],
      [80, input.mint],
    ]) {
      data.splice(offset, 32, ...key.match(/../g).map((b) => parseInt(b, 16)));
    }
    const enroll = await buildCampaignSetupInstructionBase(sdk, {
      ...input,
      op: 145,
      position: { ...input.position, owner: input.program, data },
    });
    const wire = create.instruction.data.slice();
    wire[0] = 161;
    return {
      ...create,
      op: 161,
      memberIndex: enroll.memberIndex,
      allocations: [...create.allocations, ...enroll.allocations],
      instruction: {
        ...create.instruction,
        data: wire,
        accounts: [
          ...create.instruction.accounts.slice(0, -1),
          ...enroll.instruction.accounts.slice(2),
        ],
      },
    };
  }
  const s = structuredClone(input),
    enc = sdk.getAddressEncoder(),
    dec = sdk.getAddressDecoder();
  const bytes = (h) => {
    if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) {
      throw Error("invalid setup identity");
    }
    return Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
  };
  const hex = (b) => Array.from(b, (v) => v.toString(16).padStart(2, "0")).join(""),
    address = (h) => dec.decode(bytes(h));
  const program = address(s.program),
    owner = address(s.owner),
    system = "11111111111111111111111111111111";
  const derive = async (seed, ...rest) =>
    hex(
      enc.encode(
        (
          await sdk.getProgramDerivedAddress({ programAddress: program, seeds: [seed, ...rest] })
        )[0],
      ),
    );
  const number = (a, o) => new DataView(Uint8Array.from(a.data).buffer).getBigUint64(o, true),
    field = (a, o) => hex(Uint8Array.from(a.data.slice(o, o + 32)));
  const record = (a, magic, size) => {
    if (
      a?.owner !== s.program ||
      a.executable !== false ||
      !Array.isArray(a.data) ||
      a.data.length !== size ||
      a.data.some((b) => !Number.isInteger(b) || b < 0 || b > 255) ||
      new TextDecoder().decode(Uint8Array.from(a.data.slice(0, 8))) !== magic ||
      a.data[8] !== 1 ||
      a.data[9] !== 0 ||
      a.data.slice(12, 16).some(Boolean)
    ) {
      throw Error("invalid setup account");
    }
  };
  const empty = (a) =>
    a?.owner === "00".repeat(32) &&
    a.executable === false &&
    Array.isArray(a.data) &&
    a.data.length === 0 &&
    a.lamports === 0n;
  const u64 = (n) => {
    if (!uint(n)) {
      throw Error("invalid setup integer");
    }
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return b;
  };
  const position = await derive("wen-retail-position-v2", bytes(s.owner), bytes(s.mint));
  if (s.position?.address !== position) {
    throw Error("setup position PDA mismatch");
  }
  const accounts = [
      { address: owner, role: 3 },
      { address: address(position), role: 1 },
    ],
    allocations = [];
  let values = [],
    deposit = 0n,
    memberIndex = null;
  if (s.op === 132) {
    const w = s.window;
    record(w, "WENRCMP2", 256);
    if (
      !empty(s.position) ||
      !uint(s.now) ||
      w.data[10] !== 0 ||
      !validCampaignWindowFlags(w.data[11]) ||
      (w.data[11] & 1) !== 0 ||
      ((w.data[11] & 4) !== 0 && !atomic) ||
      field(w, 16) !== s.issuer ||
      field(w, 48) !== s.mint ||
      w.address !==
        (await derive("wen-retail-window-v2", bytes(s.issuer), bytes(s.mint), u64(number(w, 112))))
    ) {
      throw Error("invalid initial campaign");
    }
    const t = s.terms;
    if (
      !t ||
      Object.keys(t).toSorted().join(",") !== "daily,deposit,expiry,maxPrice,maxWait,total" ||
      Object.values(t).some((v) => !uint(v)) ||
      t.deposit === 0n ||
      t.daily === 0n ||
      t.total === 0n ||
      t.maxWait === 0n ||
      t.maxPrice < number(w, 120) ||
      t.expiry < number(w, 136) ||
      s.now >= number(w, 128)
    ) {
      throw Error("invalid initial position terms");
    }
    const fee = number(w, 232),
      reserved = number(w, 248),
      float = number(w, 240);
    if (fee === 0n || reserved + fee * 3n > float || number(w, 216) === 0xffffffffffffffffn) {
      throw Error("initial campaign execution capacity");
    }
    deposit = t.deposit;
    values = [t.deposit, t.maxPrice, t.daily, t.total, t.expiry, t.maxWait, 0n];
    accounts.push({ address: address(w.address), role: 1 });
    allocations.push({ address: address(position), bytes: 256 });
  } else if (s.op === 145) {
    const p = s.position;
    record(p, "WENRPOS2", 256);
    if (
      field(p, 16) !== s.owner ||
      field(p, 48) !== s.issuer ||
      field(p, 80) !== s.mint ||
      p.data[225] !== 0 ||
      p.data[10] > 1 ||
      p.data[184] !== 0 ||
      p.data[224] > 1 ||
      p.data[226] > 1
    ) {
      throw Error("invalid standing enrollment");
    }
    const g = s.registry,
      registry = await derive("wen-retail-members-v2", bytes(s.issuer), bytes(s.mint));
    if (g?.address !== registry) {
      throw Error("enrollment registry PDA");
    }
    memberIndex = 0n;
    if (empty(g)) {
      allocations.push({ address: address(registry), bytes: 112 });
    } else {
      record(g, "WENRMEM2", 112);
      if (field(g, 16) !== s.issuer || field(g, 48) !== s.mint) {
        throw Error("enrollment registry binding");
      }
      memberIndex = number(g, 80);
    }
    if (memberIndex === 0xffffffffffffffffn) {
      throw Error("enrollment registry full");
    }
    const member = await derive("wen-retail-member-v2", bytes(registry), u64(memberIndex));
    if (s.member?.address !== member || !empty(s.member)) {
      throw Error("enrollment member unavailable");
    }
    accounts.push({ address: address(registry), role: 1 }, { address: address(member), role: 1 });
    allocations.push({ address: address(member), bytes: 80 });
  } else {
    throw Error("unsupported setup operation");
  }
  accounts.push({ address: system, role: 0 });
  if (
    new Set(accounts.map((a) => a.address)).size !== accounts.length ||
    accounts.some((a) => a.address === program)
  ) {
    throw Error("aliased setup accounts");
  }
  return {
    instruction: { programAddress: program, accounts, data: encodeCampaignCandidate(s.op, values) },
    op: s.op,
    allocations,
    memberIndex,
    ownerDebitLamports: deposit,
    ownerCreditLamports: 0n,
    ownerSignatureRequired: true,
    spendingEnabled: false,
    scope: "unsigned-campaign-setup",
  };
}

export async function buildCampaignSetupInstruction(sdk, input) {
  return applyCampaignAccountingContext(
    sdk,
    await buildCampaignSetupInstructionBase(sdk, input),
    input,
  );
}
