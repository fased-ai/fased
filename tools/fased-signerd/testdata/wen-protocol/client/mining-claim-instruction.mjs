// Pure unsigned SAT-v1 claim codec. No RPC, fee quote, eligibility assertion or
// signing authority. Host admission and finalized account checks must precede use.
export async function buildMiningClaimInstruction(sdk, request) {
  const v = structuredClone(request);
  const fields = ["program", "owner", "sale", "id", "nonce", "ordinal", "operation"];
  if (v?.operation === "sat") {
    fields.push("destination");
  }
  if (
    !v ||
    !["sol", "sat"].includes(v.operation) ||
    Object.keys(v).length !== fields.length ||
    fields.some((k) => !Object.hasOwn(v, k))
  ) {
    throw Error("invalid mining claim request");
  }
  const key = (value) => {
    if (typeof value !== "string") {
      throw Error("invalid claim address");
    }
    const address = sdk.address(value);
    const bytes = sdk.getAddressEncoder().encode(address);
    if (sdk.getAddressDecoder().decode(bytes) !== value || bytes.every((x) => x === 0)) {
      throw Error("invalid claim address");
    }
    return bytes;
  };
  const u64 = (value) => {
    if (typeof value !== "bigint" || value < 0n || value > 0xffffffffffffffffn) {
      throw Error("invalid claim integer");
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return bytes;
  };
  const program = v.program,
    owner = key(v.owner),
    sale = key(v.sale);
  key(program);
  const id = u64(v.id),
    nonce = u64(v.nonce),
    ordinal = u64(v.ordinal);
  const text = new TextEncoder();
  const pda = async (seed, ...seeds) =>
    (
      await sdk.getProgramDerivedAddress({
        programAddress: program,
        seeds: [text.encode(seed), ...seeds],
      })
    )[0];
  const prep = await pda("wen-mining-preparation-v1", sale, id);
  const offer = await pda("wen-mining-offer-v1", sale, key(prep));
  const roster = await pda("wen-mining-roster-v1", sale, key(offer));
  const entry = await pda("wen-mining-entry-v1", key(offer), owner, nonce);
  const receipt = await pda("wen-mining-progress-v1", sale, key(offer));
  const claim = await pda("wen-mining-claim-v1", sale, key(entry));
  // Solana Kit role bits: readonly=0, writable=1, signer=2.
  const accounts = [
    { address: v.owner, role: 3 },
    { address: v.sale, role: 0 },
    { address: offer, role: 0 },
    { address: roster, role: 0 },
    { address: receipt, role: 1 },
    { address: entry, role: 0 },
    { address: claim, role: 1 },
  ];
  if (v.operation === "sat") {
    key(v.destination);
    accounts.push(
      { address: await pda("wen-activation-v1", sale), role: 0 },
      { address: await pda("wen-mining-reserved-v1", sale), role: 1 },
      { address: await pda("wen-allocation-v1", sale, new Uint8Array([3])), role: 1 },
      { address: v.destination, role: 1 },
      { address: await pda("wen-sat-mint-v1", sale), role: 0 },
      { address: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", role: 0 },
    );
  }
  if (
    new Set(accounts.map((a) => a.address)).size !== accounts.length ||
    accounts.some((a) => a.address === program)
  ) {
    throw Error("aliased mining claim accounts");
  }
  const data = new Uint8Array(25);
  data[0] = v.operation === "sol" ? 82 : 83;
  data.set(id, 1);
  data.set(nonce, 9);
  data.set(ordinal, 17);
  return Object.freeze({
    programAddress: program,
    accounts: Object.freeze(accounts.map(Object.freeze)),
    data,
  });
}
