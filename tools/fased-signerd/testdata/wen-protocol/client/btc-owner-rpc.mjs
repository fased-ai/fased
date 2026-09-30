import { validateBtcOwnerReward } from "./btc-owner-reward.mjs";
import { deriveBtcAccounts } from "./btc-readback.mjs";
import { validateBtcTransferPreview, BTC_TOKEN_PROGRAM } from "./btc-transfer-preview.mjs";
import { networkProfile } from "./network-profile.mjs";
import { createReadbackRpc } from "./rpc-readback.mjs";
import { decodeSale } from "./sale.mjs";
import { validateStakingActivation } from "./staking-activation.mjs";

// All six accounting records, deployment and Clock share one finalized context.
// Asset admission and executable transfer custody are deliberately separate.
export function createBtcOwnerRewardReader(config) {
  const { identity, expectedProgram, genesis } = structuredClone({
    identity: config.identity,
    expectedProgram: config.expectedProgram,
    genesis: config.genesis,
  });
  const profileLabel = networkProfile(config.networkProfile).label;
  const sdk = config.sdk,
    enc = sdk.getAddressEncoder();
  const hex = (a) => Array.from(enc.encode(a), (b) => b.toString(16).padStart(2, "0")).join("");
  for (const f of ["program", "sale", "policy", "owner", "usdc", "mint"]) {
    sdk.assertIsAddress(identity?.[f]);
  }
  if (
    !expectedProgram ||
    hex(identity.program) !== expectedProgram.program ||
    typeof genesis !== "string" ||
    !genesis
  ) {
    throw Error("BTC deployment pins required");
  }
  const read = createReadbackRpc({
    ...config,
    expectedProgram,
    accountCount: identity.destination ? 12 : 6,
  });
  return async ({ day, from, minSlot }) => {
    for (const n of [day, from]) {
      if (typeof n !== "bigint" || n < 0n || n > 0xffffffffffffffffn) {
        throw Error("invalid BTC reward interval");
      }
    }
    if (from > day || typeof minSlot !== "bigint" || minSlot < expectedProgram.deploymentSlot) {
      throw Error("invalid BTC observation floor");
    }
    const id = { ...identity, day, from },
      p = await deriveBtcAccounts(sdk, id);
    const seed = new Uint8Array(8);
    new DataView(seed.buffer).setBigUint64(0, from, true);
    const derive = async (seeds) =>
      (await sdk.getProgramDerivedAddress({ programAddress: identity.program, seeds }))[0];
    const history = await derive([
      "wen-stake-history-v1",
      enc.encode(identity.sale),
      enc.encode(identity.owner),
      seed,
    ]);
    const paid = await derive([
      "wen-btc-paid-v1",
      enc.encode(p.funding[0]),
      enc.encode(identity.owner),
    ]);
    const fallback = await derive([
      "wen-btc-fallback-v1",
      enc.encode(p.funding[0]),
      enc.encode(identity.owner),
    ]);
    const vault = await derive(["wen-btc-reward-v1", enc.encode(p.funding[0])]);
    const authority = await derive(["wen-btc-swap-v1", enc.encode(p.funding[0])]);
    const activation = await derive(["wen-activation-v1", enc.encode(identity.sale)]);
    const extras = identity.destination
      ? [identity.mint, vault, identity.destination, BTC_TOKEN_PROGRAM, identity.sale, activation]
      : [];
    const page = await read(
      [p.funding[0], p.settlement[0], p.cohort[0], history, paid, fallback, ...extras].map(hex),
      { genesis, minSlot, commitment: "finalized" },
    );
    const [f, s, c, h, b, u] = page.accounts;
    const result = await validateBtcOwnerReward(
      sdk,
      { funding: f, settlement: s, cohort: c, history: h, paid: b, fallback: u },
      { ...id, now: page.now },
    );
    if (identity.destination) {
      await validateStakingActivation(
        sdk,
        { sale: page.accounts[10], activation: page.accounts[11] },
        id,
        page.now,
      );
      if (decodeSale(page.accounts[10].data).mint !== hex(identity.usdc)) {
        throw Error("BTC sale quote mint mismatch");
      }
    }
    const transfer =
      identity.destination && result.status === "unpaid-btc-allocation"
        ? validateBtcTransferPreview(
            sdk,
            {
              mint: page.accounts[6],
              vault: page.accounts[7],
              destination: page.accounts[8],
              tokenProgram: page.accounts[9],
            },
            { ...identity, vault, authority },
            result,
            profileLabel,
          )
        : {};
    return Object.freeze({
      ...result,
      ...(f.data[8] === 2 ? { fundingVersion: 2 } : {}),
      owner: identity.owner,
      rewardDay: day.toString(),
      historyFrom: from.toString(),
      slot: page.slot.toString(),
      referenceSlot: page.referenceSlot.toString(),
      chainTime: page.now.toString(),
      ...(identity.destination
        ? {
            saleCreator: sdk
              .getAddressDecoder()
              .decode(
                Uint8Array.from(decodeSale(page.accounts[10].data).creator.match(/../g), (v) =>
                  parseInt(v, 16),
                ),
              ),
          }
        : {}),
      commitment: "finalized",
      scope: "historical-accounting-only",
      custodyVerified: false,
      networkCostsIncluded: false,
      activationVerified: Boolean(identity.destination),
      ...transfer,
    });
  };
}
