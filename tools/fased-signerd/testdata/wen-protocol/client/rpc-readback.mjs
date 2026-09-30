import { verifyProgram } from "./program.mjs";
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const SYSVAR = "Sysvar1111111111111111111111111111111111111";
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
export function decodeReadbackAccountData(encoded) {
  const raw = atob(encoded);
  if (btoa(raw) !== encoded) {
    throw new Error("invalid base64");
  }
  // ProgramData is megabytes long. String iteration plus a callback allocates
  // per character; a counted loop preserves the exact bytes without that cost.
  const data = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    data[i] = raw.charCodeAt(i);
  }
  return data;
}
export function createReadbackRpc({
  endpoint,
  sdk,
  maxSlotLag,
  expectedProgram,
  accountCount = 7,
  includeLamports = false,
  readCommitment = "finalized",
  fetcher = fetch,
}) {
  if (!["finalized", "confirmed"].includes(readCommitment)) {
    throw new Error("invalid read commitment");
  }
  if (typeof includeLamports !== "boolean") {
    throw new Error("invalid lamport mode");
  }
  if (!Number.isInteger(accountCount) || accountCount < 1 || accountCount > 32) {
    throw new Error("invalid account count");
  }
  const deployment = expectedProgram === undefined ? undefined : structuredClone(expectedProgram);
  // ProgramData includes base64 expansion of the pinned successor binary.
  // Keep a fixed transport cap; ordinary account-only reads retain their limit.
  const responseLimit = deployment ? 4 * 1024 * 1024 : 2000000;
  if (typeof maxSlotLag !== "bigint" || maxSlotLag < 0n) {
    throw new Error("invalid freshness allowance");
  }
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("invalid RPC endpoint");
  }
  let next = 0;
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const encode = sdk.getAddressEncoder(),
    decode = sdk.getAddressDecoder();
  async function rpc(method, params) {
    const id = ++next;
    // The pinned ProgramData account is much larger than ordinary RPC reads.
    const timeoutMs = deployment && method === "getMultipleAccounts" ? 15000 : 5000;
    const response = await fetcher(url.href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200 || !response.body) {
      throw new Error("RPC unavailable: HTTP " + response.status + " for " + method);
    }
    const reader = response.body.getReader();
    let text = "",
      size = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        size += value.length;
        if (size > responseLimit) {
          await reader.cancel();
          throw new Error("oversized RPC");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    const result = JSON.parse(text);
    if (
      result.jsonrpc !== "2.0" ||
      result.id !== id ||
      "error" in result ||
      !("result" in result)
    ) {
      throw new Error("invalid RPC envelope");
    }
    return result.result;
  }
  return async function readBatch(addresses, { genesis, minSlot, commitment }) {
    if (
      commitment !== readCommitment ||
      typeof minSlot !== "bigint" ||
      minSlot < 0n ||
      minSlot > BigInt(Number.MAX_SAFE_INTEGER) ||
      !Array.isArray(addresses) ||
      addresses.length !== accountCount
    ) {
      throw new Error("invalid RPC batch");
    }
    const bound = [...addresses];
    const keys = bound.map((value) => {
      if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
        throw new Error("invalid address");
      }
      return decode.decode(Uint8Array.from(value.match(/../g), (b) => parseInt(b, 16)));
    });
    if (deployment) {
      if (typeof deployment.program !== "string" || !/^[0-9a-f]{64}$/.test(deployment.program)) {
        throw new Error("invalid deployment pin");
      }
      const bytes = Uint8Array.from(deployment.program.match(/../g), (b) => parseInt(b, 16));
      const [dataAddress] = await sdk.getProgramDerivedAddress({
        programAddress: "BPFLoaderUpgradeab1e11111111111111111111111",
        seeds: [bytes],
      });
      keys.push(decode.decode(bytes), dataAddress);
      bound.push(deployment.program, hex(encode.encode(dataAddress)));
    }
    let page,
      accounts,
      now,
      slotFloor = Number(minSlot),
      coherent = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const params = [
        [...keys, CLOCK],
        { commitment: readCommitment, encoding: "base64", minContextSlot: slotFloor },
      ];
      if (attempt === 0) {
        // Independent read-only requests may overlap. No account data is used
        // until both results arrive and the cluster pin is checked.
        const [cluster, first] = await Promise.all([
          rpc("getGenesisHash", []),
          rpc("getMultipleAccounts", params),
        ]);
        if (cluster !== genesis) {
          throw new Error("wrong RPC cluster");
        }
        page = first;
      } else {
        page = await rpc("getMultipleAccounts", params);
      }
      if (
        !integer(page?.context?.slot) ||
        page.context.slot < slotFloor ||
        !Array.isArray(page.value) ||
        page.value.length !== keys.length + 1
      ) {
        throw new Error("invalid RPC account batch");
      }
      accounts = page.value.map((account, i) => {
        if (account === null) {
          return null;
        }
        if (
          typeof account?.executable !== "boolean" ||
          !Array.isArray(account.data) ||
          account.data.length !== 2 ||
          account.data[1] !== "base64" ||
          typeof account.data[0] !== "string"
        ) {
          throw new Error("invalid RPC account");
        }
        const data = decodeReadbackAccountData(account.data[0]);
        if (includeLamports && !integer(account.lamports)) {
          throw new Error("invalid RPC lamports");
        }
        return {
          ...(includeLamports ? { lamports: BigInt(account.lamports) } : {}),
          address: i === keys.length ? hex(encode.encode(CLOCK)) : bound[i],
          owner: hex(encode.encode(account.owner)),
          executable: account.executable,
          data,
        };
      });
      const clock = accounts.pop();
      if (
        !clock ||
        clock.owner !== hex(encode.encode(SYSVAR)) ||
        clock.executable ||
        clock.data.length !== 40
      ) {
        throw new Error("invalid Clock sysvar");
      }
      const view = new DataView(clock.data.buffer);
      if (view.getBigUint64(0, true) === BigInt(page.context.slot)) {
        now = view.getBigInt64(32, true);
        if (now < 0n) {
          throw new Error("invalid chain time");
        }
        coherent = true;
        break;
      }
      slotFloor = page.context.slot;
    }
    if (!coherent) {
      throw new Error("Clock context mismatch");
    }
    let verifiedProgram;
    if (deployment) {
      const [program, data] = accounts.splice(accountCount);
      verifiedProgram = await verifyProgram({
        sdk,
        expected: deployment,
        contextSlot: BigInt(page.context.slot),
        program: program && { ...program, slot: BigInt(page.context.slot) },
        data: data && { ...data, slot: BigInt(page.context.slot) },
      });
    }
    const reference = await rpc("getSlot", [
      { commitment: readCommitment, minContextSlot: page.context.slot },
    ]);
    if (
      !integer(reference) ||
      reference < page.context.slot ||
      BigInt(reference - page.context.slot) > maxSlotLag
    ) {
      throw new Error("stale RPC batch");
    }
    return {
      genesis,
      commitment: readCommitment,
      slot: BigInt(page.context.slot),
      referenceSlot: BigInt(reference),
      now,
      accounts,
      verifiedProgram,
    };
  };
}
