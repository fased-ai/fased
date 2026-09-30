import { bindOwnerClaimDescriptor } from "./claim-descriptor.mjs";
import { bindInventoryClaimDescriptor } from "./inventory-claim-descriptor.mjs";
import { verifyNativeClaimReceipt, verifyInventoryClaimReceipt } from "./staking-claim-receipt.mjs";
import { createNativeClaimSession, createInventoryClaimSession } from "./staking-claim-session.mjs";
import { createClaimWalletSigner } from "./wallet-standard.mjs";
// Host-owned pins, selected owner/destination and durable journal. No auto-connect.
export const createNativeClaimClient = (config) => createSatClaimClient(config, false);
export const createInventoryClaimClient = (config) => createSatClaimClient(config, true);
function createSatClaimClient(config, stock) {
  const { sdk, journal } = config,
    pins = structuredClone({
      identity: config.identity,
      expectedProgram: config.expectedProgram,
      genesis: config.genesis,
      chain: config.chain,
    });
  const binding = structuredClone(config.descriptorBinding),
    awardVersion = config.awardVersion ?? 1;
  if (stock && ![1, 2].includes(awardVersion)) {
    throw Error("invalid inventory award version");
  }
  if (!(binding?.bytes instanceof Uint8Array)) {
    throw new Error("claim descriptor binding required");
  }
  let verified;
  const verify = () =>
    (verified ??= (async () => {
      const d = await (stock ? bindInventoryClaimDescriptor : bindOwnerClaimDescriptor)(
        binding.bytes,
        binding.sha256,
        binding.capabilityDigest,
        ...(stock ? [awardVersion] : []),
      );
      const p = d.deployment[stock ? "inventoryClaim" : "ownerClaim"];
      if (
        !p ||
        p.genesis !== pins.genesis ||
        p.program !== pins.expectedProgram.program ||
        p.deploymentSlot !== pins.expectedProgram.deploymentSlot.toString() ||
        p.upgradeAuthority !== pins.expectedProgram.upgradeAuthority ||
        p.deployedBytesHash !== pins.expectedProgram.deployedBytesHash
      ) {
        throw new Error("claim descriptor deployment mismatch");
      }
    })());
  const url = new URL(config.endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("invalid claim RPC endpoint");
  }
  if (
    !["solana:localnet", "solana:devnet", "solana:testnet", "solana:mainnet"].includes(
      pins.chain,
    ) ||
    typeof journal?.list !== "function"
  ) {
    throw new Error("claim wallet chain and enumerable journal required");
  }
  const hex = (a) =>
    Array.from(sdk.getAddressEncoder().encode(a), (b) => b.toString(16).padStart(2, "0")).join("");
  const owner = hex(pins.identity.owner),
    program = hex(pins.identity.program);
  const rpc = sdk.createSolanaRpc(url.href);
  const session = (stock ? createInventoryClaimSession : createNativeClaimSession)({
    ...config,
    ...pins,
    awardVersion,
    endpoint: url.href,
    rpc,
  });
  return Object.freeze({
    async prepare(input) {
      const { minSlot } = input;
      await verify();
      const floor = pins.expectedProgram.deploymentSlot;
      if (
        typeof floor !== "bigint" ||
        floor < 0n ||
        typeof minSlot !== "bigint" ||
        minSlot < floor
      ) {
        throw new Error("claim read precedes deployment");
      }
      return session.prepare(input);
    },
    async submit(ticket, sign, guard) {
      await verify();
      return session.submit(ticket, sign, guard);
    },
    async submitWithWallet(ticket, wallet, account, guard) {
      await verify();
      if (ticket?.owner !== owner || ticket.program !== program) {
        throw new Error("wrong claim ticket owner");
      }
      return session.submit(
        ticket,
        createClaimWalletSigner({ sdk, wallet, account, owner, chain: pins.chain }),
        guard,
      );
    },
    async recover(signature) {
      await verify();
      const record = await journal.get(signature);
      if (
        record?.owner !== owner ||
        record.program !== program ||
        record.genesis !== pins.genesis
      ) {
        throw new Error("wrong claim recovery scope");
      }
      if (stock && (record?.recovery?.awardVersion ?? 1) !== awardVersion) {
        throw Error("inventory recovery capability version mismatch");
      }
      return session.recover(signature);
    },
    async recoverReceipt(signature) {
      await verify();
      const record = await journal.get(signature);
      if (
        record?.owner !== owner ||
        record.program !== program ||
        record.genesis !== pins.genesis
      ) {
        throw Error("wrong claim recovery scope");
      }
      if (stock && (record?.recovery?.awardVersion ?? 1) !== awardVersion) {
        throw Error("inventory recovery capability version mismatch");
      }
      if (
        record?.recovery?.kind !==
        (stock ? "inventory-claim-effects-v1" : "native-claim-effects-v1")
      ) {
        if (stock) {
          throw Error("wrong SAT claim recovery kind");
        }
        return session.reconcile(await session.recover(signature));
      }
      if ((await rpc.getGenesisHash().send()) !== pins.genesis) {
        throw Error("wrong claim recovery cluster");
      }
      const result = await rpc
        .getTransaction(signature, {
          encoding: "base64",
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        })
        .send();
      const finalizedSlot = await rpc.getSlot({ commitment: "finalized" }).send();
      if ((await rpc.getGenesisHash().send()) !== pins.genesis) {
        throw Error("wrong claim recovery cluster");
      }
      if (result === null) {
        return Object.freeze({ signature, status: "unobserved", effectsVerified: false });
      }
      return (stock ? verifyInventoryClaimReceipt : verifyNativeClaimReceipt)({
        sdk,
        identity: pins.identity,
        genesis: pins.genesis,
        record,
        result,
        finalizedSlot,
      });
    },
    async reconcile(ticket) {
      await verify();
      return session.reconcile(ticket);
    },
    async listPending() {
      await verify();
      const result = [];
      for (const signature of await journal.list()) {
        const record = await journal.get(signature);
        if (
          record?.owner === owner &&
          record.program === program &&
          record.genesis === pins.genesis
        ) {
          result.push(signature);
        }
      }
      return result;
    },
  });
}
