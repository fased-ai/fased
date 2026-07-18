import { describe, expect, it } from "vitest";
import {
  buildLocalSignerPolicyTightening,
  localSignerPolicyState,
} from "./local-socket-signer-policy.js";
import type { LocalSocketSignerPolicyV2 } from "./local-socket-signer-protocol.js";

const destination = "Vote111111111111111111111111111111111111111";
const systemProgram = "11111111111111111111111111111111";
const federationDomain = "domain:fased:federation-bond-challenge-v1";
const mint = "So11111111111111111111111111111111111111112";

function signerPolicy(): LocalSocketSignerPolicyV2 {
  return {
    walletId: "agent",
    role: "agent",
    version: 4,
    operations: ["solana.nativeTransfer", "solana.splTransferChecked"],
    programs: [systemProgram, federationDomain],
    assets: [
      {
        asset: "solana:native",
        destinations: [destination],
        maxPerTx: "10000000",
        maxDaily: "50000000",
      },
      {
        asset: `solana:spl:${mint}`,
        destinations: [destination],
        maxPerTx: "100",
        maxDaily: "500",
      },
    ],
    hash: `sha256:${"a".repeat(64)}`,
  };
}

const gatewayPolicy = {
  capsEnabled: true,
  directSigning: false,
  skillsEnabled: false,
  solana: {
    allowPrograms: [systemProgram, federationDomain],
    maxPerTx: "10000000",
    maxDaily: "50000000",
    tokenCaps: { [mint]: { maxPerTx: "100", maxDaily: "500" } },
  },
};

describe("local signer application policy tightening", () => {
  it("reduces only existing signer programs and asset caps", () => {
    const candidate = buildLocalSignerPolicyTightening({
      current: signerPolicy(),
      expectedRole: "agent",
      gatewayPolicy,
      hosting: false,
      patch: {
        solanaAllowPrograms: [systemProgram],
        solanaMaxPerTx: "5000000",
        solanaMaxDaily: "20000000",
        solanaTokenCaps: { [mint]: { maxPerTx: "50", maxDaily: "200" } },
      },
    });
    expect(candidate.programs).toEqual([systemProgram]);
    expect(candidate.assets).toEqual([
      expect.objectContaining({
        asset: "solana:native",
        maxPerTx: "5000000",
        maxDaily: "20000000",
      }),
      expect.objectContaining({ asset: `solana:spl:${mint}`, maxPerTx: "50", maxDaily: "200" }),
    ]);
    expect(candidate.operations).toEqual(signerPolicy().operations);
    expect(candidate.assets[0]?.destinations).toEqual([destination]);
  });

  it("does not let unchanged legacy Gateway values overwrite signer-owned truth", () => {
    const staleGatewayPolicy = {
      ...gatewayPolicy,
      solana: {
        ...gatewayPolicy.solana,
        allowPrograms: [],
        maxPerTx: "90000000",
        maxDaily: "90000000",
      },
    };
    const candidate = buildLocalSignerPolicyTightening({
      current: signerPolicy(),
      expectedRole: "agent",
      gatewayPolicy: staleGatewayPolicy,
      hosting: false,
      patch: {
        solanaAllowPrograms: [],
        solanaMaxPerTx: "90000000",
        solanaMaxDaily: "90000000",
      },
    });
    expect(candidate).toEqual(signerPolicy());
  });

  it("rejects program, asset, cap, preset, and role expansion with host-admin guidance", () => {
    const cases = [
      {
        patch: { solanaAllowPrograms: [systemProgram, "new-domain"] },
        message: /adding Gateway program permission/i,
      },
      {
        patch: { solanaMaxPerTx: "10000001" },
        message: /cannot be raised through the Gateway/i,
      },
      {
        patch: { solanaTokenCaps: { NewMint: { maxPerTx: "1", maxDaily: "1" } } },
        message: /adding signer asset permission/i,
      },
      { patch: { policyTemplate: "recommended" }, message: /presets are not signer-exact/i },
    ];
    for (const testCase of cases) {
      expect(() =>
        buildLocalSignerPolicyTightening({
          current: signerPolicy(),
          expectedRole: "agent",
          gatewayPolicy,
          hosting: true,
          patch: testCase.patch,
        }),
      ).toThrow(testCase.message);
      expect(() =>
        buildLocalSignerPolicyTightening({
          current: signerPolicy(),
          expectedRole: "agent",
          gatewayPolicy,
          hosting: true,
          patch: testCase.patch,
        }),
      ).toThrow(/authenticated host-administrator session/i);
    }
    expect(() =>
      buildLocalSignerPolicyTightening({
        current: signerPolicy(),
        expectedRole: "vault",
        gatewayPolicy,
        hosting: false,
        patch: {},
      }),
    ).toThrow(/roles are immutable/i);
  });

  it("rejects app-policy widening even when the result stays inside signer authority", () => {
    const narrowGateway = {
      ...gatewayPolicy,
      solana: {
        ...gatewayPolicy.solana,
        allowPrograms: [systemProgram],
        maxPerTx: "5000000",
        maxDaily: "10000000",
      },
    };
    const cases = [
      { patch: { directSigning: true }, message: /direct signing cannot be enabled/i },
      { patch: { skillsEnabled: true }, message: /Skill wallet access cannot be enabled/i },
      { patch: { capsEnabled: false }, message: /spend caps cannot be disabled/i },
      {
        patch: { solanaAllowPrograms: [systemProgram, federationDomain] },
        message: /Adding Gateway program permission/i,
      },
      {
        patch: { solanaMaxPerTx: "5000001" },
        message: /cannot be raised through the Gateway/i,
      },
    ];
    for (const testCase of cases) {
      expect(() =>
        buildLocalSignerPolicyTightening({
          current: signerPolicy(),
          expectedRole: "agent",
          gatewayPolicy: narrowGateway,
          hosting: false,
          patch: testCase.patch,
        }),
      ).toThrow(testCase.message);
    }
  });

  it("keeps an explicit deny-all wallet locked and rejects app-side enablement", () => {
    const locked = {
      ...signerPolicy(),
      operations: [],
      programs: [],
      assets: [],
    };
    expect(localSignerPolicyState(locked)).toBe("locked");
    expect(() =>
      buildLocalSignerPolicyTightening({
        current: locked,
        expectedRole: "agent",
        gatewayPolicy,
        hosting: false,
        patch: { directSigning: true },
      }),
    ).toThrow(/explicit deny-all policy/i);
  });

  it("does not call an unusable asset allowlist acknowledged", () => {
    expect(localSignerPolicyState({ ...signerPolicy(), assets: [] })).toBe("locked");
    expect(
      localSignerPolicyState({
        ...signerPolicy(),
        assets: signerPolicy().assets.map((asset) => ({ ...asset, destinations: [] })),
      }),
    ).toBe("locked");
    expect(
      localSignerPolicyState({
        ...signerPolicy(),
        assets: [{ ...signerPolicy().assets[0], maxDaily: "0" }],
      }),
    ).toBe("locked");
  });

  it("locks pre-upgrade on-chain policies below the signer fee reserve without locking federation-only proof policies", () => {
    expect(
      localSignerPolicyState({
        ...signerPolicy(),
        assets: signerPolicy().assets.map((asset) =>
          asset.asset === "solana:native"
            ? { ...asset, maxPerTx: "4999999", maxDaily: "5000000" }
            : asset,
        ),
      }),
    ).toBe("locked");
    expect(
      localSignerPolicyState({
        walletId: "vault",
        role: "vault",
        version: 1,
        operations: ["federation.bondChallenge"],
        programs: [federationDomain],
        assets: [
          {
            asset: "federation:bond-challenge",
            destinations: [destination],
            maxPerTx: "1",
            maxDaily: "2",
          },
        ],
        hash: `sha256:${"b".repeat(64)}`,
      }),
    ).toBe("acknowledged");
  });
});
