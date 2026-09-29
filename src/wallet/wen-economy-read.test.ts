import { describe, expect, it } from "vitest";
import { readWenEconomyLocal, type WenEconomyReadPin } from "./wen-economy-read.js";

const pin: WenEconomyReadPin = {
  economy: "sat-v1",
  genesis: "devnet",
  program: "program",
  mint: "mint",
  deployedBytesHash: "a".repeat(64),
  deploymentSlot: "12",
  upgradeAuthority: null,
};
const row = (id: string, status: "reported" | "unavailable" = "reported") =>
  status === "reported"
    ? {
        id,
        status,
        value: "10",
        unit: "atoms",
        evidence: "onchain",
        source: "account",
        scope: "Observed custody only",
        observedAtMs: 1000,
      }
    : { id, status, value: null, reason: "Coverage incomplete" };
const snapshot = () => ({
  schema: "wen.economy.read.v1",
  mode: "local-devnet-read-only",
  signingEnabled: false,
  identity: { economy: pin.economy, genesis: pin.genesis, program: pin.program, mint: pin.mint },
  deployment: {
    deployedBytesHash: pin.deployedBytesHash,
    deploymentSlot: pin.deploymentSlot,
    upgradeAuthority: null,
  },
  slot: "13",
  observedAtMs: 1000,
  rows: [
    row("issuedSupply"),
    row("unmintedObligations"),
    row("protocolAsset"),
    row("economicNav", "unavailable"),
  ],
});
const read = (body: unknown, url = "http://127.0.0.1:3004/api/v1/economies/sat-v1/factsheet") =>
  readWenEconomyLocal({
    url,
    pin,
    nowMs: 1100,
    maxAgeMs: 200,
    fetcher: async () => new Response(JSON.stringify(body), { status: 200 }),
  });

describe("WEN local read interface", () => {
  it("consumes pinned, fresh facts with explicit unavailable NAV and no signing capability", async () => {
    const result = await read(snapshot());
    expect(result.rows.find((r) => r.id === "issuedSupply")?.status).toBe("reported");
    expect(result.rows.find((r) => r.id === "economicNav")?.status).toBe("unavailable");
    expect(result.signingEnabled).toBe(false);
  });
  it("rejects changed network, deployment, stale and invented complete NAV", async () => {
    for (const mutate of [
      (v: ReturnType<typeof snapshot>) => {
        v.identity.genesis = "other";
      },
      (v: ReturnType<typeof snapshot>) => {
        v.deployment.deployedBytesHash = "b".repeat(64);
      },
      (v: ReturnType<typeof snapshot>) => {
        v.observedAtMs = 899;
      },
      (v: ReturnType<typeof snapshot>) => {
        v.signingEnabled = true;
      },
      (v: ReturnType<typeof snapshot>) => {
        v.rows[3] = row("economicNav");
      },
      (v: ReturnType<typeof snapshot>) => {
        v.rows[2] = row("issuedSupply");
      },
      (v: ReturnType<typeof snapshot>) => {
        v.rows.push(row("guaranteedProfit"));
      },
    ]) {
      const value = snapshot();
      mutate(value);
      await expect(read(value)).rejects.toThrow();
    }
    await expect(
      read(snapshot(), "http://example.com/api/v1/economies/sat-v1/factsheet"),
    ).rejects.toThrow();
  });
  it("rejects pre-deployment and post-snapshot provenance and carries earliest expiry", async () => {
    const value = snapshot();
    value.slot = "11";
    await expect(read(value)).rejects.toThrow("Invalid WEN read snapshot");
    value.slot = "13";
    value.observedAtMs = -1;
    await expect(read(value)).rejects.toThrow("Invalid WEN read snapshot");
    value.observedAtMs = 1000;
    value.rows[0] = { ...row("issuedSupply"), observedAtMs: 1001 } as (typeof value.rows)[number];
    await expect(read(value)).rejects.toThrow("Invalid reported WEN value");
    value.rows[0] = { ...row("issuedSupply"), observedAtMs: 950 } as (typeof value.rows)[number];
    expect((await read(value)).expiresAtMs).toBe(1151);
    await expect(
      readWenEconomyLocal({
        url: "http://127.0.0.1:3004/api/v1/economies/sat-v1/factsheet",
        pin,
        nowMs: 1100,
        maxAgeMs: 60001,
      }),
    ).rejects.toThrow("Invalid WEN read clock");
  });
});
