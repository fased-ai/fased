import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  deriveAgentCapitalRequestId,
  type AgentCapitalInstruction,
  validateAgentCapitalInstruction,
} from "./agent-capital-runtime.js";
import { FASED_AGENT_CAPITAL_CONTRACT } from "./fased-agent-capital-contract.generated.js";
import { FASED_SAT_SOL_MONEY_FOUNDATION_CONTRACT } from "./fased-sat-sol-money-foundation.generated.js";
import { validateSatSolMoneyFoundationRecord } from "./sat-sol-money-foundation.js";

type MoneyFixture = {
  path: string;
  valid: boolean;
  value: Record<string, unknown>;
};

type MoneyFixtureBundle = {
  schema: "fased.money-foundation-fixtures.v1";
  sourceCommit: string;
  valid: MoneyFixture[];
  invalid: MoneyFixture[];
};

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureBundle = JSON.parse(
  fs.readFileSync(
    path.join(here, "protocol-generation/sat-sol-money-foundation.v1.fixtures.json"),
    "utf8",
  ),
) as MoneyFixtureBundle;
const source = JSON.parse(
  fs.readFileSync(path.join(here, "protocol-generation/money-foundation.v1.source.json"), "utf8"),
) as {
  agentProtocol: { commit: string; tree: string };
  satcoin: { commit: string; tree: string };
};
function bondLayout(file: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(here, `../../token/sat/bond-api/${file}`), "utf8"),
  ) as Record<string, unknown>;
}

function deterministicKey(seed: number): string {
  return Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => seed)).publicKey.toBase58();
}

function instruction(
  action: AgentCapitalInstruction["action"],
  signer: string,
): AgentCapitalInstruction {
  const contract = FASED_AGENT_CAPITAL_CONTRACT.instructions.find(
    (candidate) => candidate.action === action,
  );
  if (!contract) {
    throw new Error(`missing Agent Capital instruction ${action}`);
  }
  const data = Buffer.alloc(contract.dataSize);
  Buffer.from(contract.discriminator).copy(data);
  return {
    action,
    programId: FASED_AGENT_CAPITAL_CONTRACT.programId,
    dataBase64: data.toString("base64"),
    keys: contract.accounts.map((account, index) => ({
      pubkey:
        "address" in account
          ? account.address
          : account.signer
            ? signer
            : deterministicKey(index + 2),
      isSigner: account.signer,
      isWritable: account.writable,
    })),
  };
}

describe("P4 cross-repository money-foundation convergence", () => {
  it("pins the exact canonical Agent-protocol and Satcoin source trees", () => {
    expect(source).toMatchObject({
      agentProtocol: expect.objectContaining({
        commit: "847d0192ef10623778dbe94575c3e35d0dd14ff3", // pragma: allowlist secret
        tree: "1b620fe687a81751e5558e27b13d3a36fe3816aa", // pragma: allowlist secret
      }),
      satcoin: expect.objectContaining({
        commit: "a6ccff6473fc302f9eb3a6ab31f749cb184c0eab", // pragma: allowlist secret
        tree: "fa337572d34002c32ff9ed7d2122ee56c666ce55", // pragma: allowlist secret
      }),
    });
    expect(FASED_AGENT_CAPITAL_CONTRACT.source.commit).toBe(source.agentProtocol.commit);
    expect(FASED_AGENT_CAPITAL_CONTRACT.source.tree).toBe(source.agentProtocol.tree);
  });

  it("accepts all canonical SAT/SOL records and rejects every red fixture", () => {
    expect(fixtureBundle.schema).toBe("fased.money-foundation-fixtures.v1");
    expect(fixtureBundle.sourceCommit).toBe(source.agentProtocol.commit);
    expect(fixtureBundle.valid).toHaveLength(5);
    expect(fixtureBundle.invalid).toHaveLength(5);
    for (const fixture of fixtureBundle.valid) {
      expect(validateSatSolMoneyFoundationRecord(fixture.value), fixture.path).toMatchObject({
        ok: true,
      });
    }
    for (const fixture of fixtureBundle.invalid) {
      expect(validateSatSolMoneyFoundationRecord(fixture.value), fixture.path).toMatchObject({
        ok: false,
      });
    }
    expect(FASED_SAT_SOL_MONEY_FOUNDATION_CONTRACT).toMatchObject({
      initialState: "DISABLED_UNFUNDED",
      leadingCanary: { authorized: false },
      canonicalPair: { base: "SAT", quote: "WSOL" },
    });
    expect(
      validateSatSolMoneyFoundationRecord({
        ...fixtureBundle.valid[0]?.value,
        policyGeneration: "18446744073709551616",
      }),
    ).toMatchObject({ ok: false });
  });

  it("keeps Bond-v3 at the selected 25/500 SAT and seven-day contract", () => {
    const policy = bondLayout("bond-tier-policy-layout.json") as {
      defaults: { basicMinRaw: string; operatorMinRaw: string };
    };
    const distributor = bondLayout("bond-epoch-distributor-v3-layout.json") as {
      version: number;
      rewardEpochSeconds: string;
      unlockDelaySlots: string;
    };
    const position = bondLayout("bond-epoch-position-v3-layout.json") as {
      version: number;
      status: { inactive: number; pending: number; active: number };
    };
    const snapshot = bondLayout("bond-epoch-snapshot-v3-layout.json") as { version: number };
    expect(policy.defaults).toMatchObject({
      basicMinRaw: "2500000000000",
      operatorMinRaw: "50000000000000",
    });
    expect(distributor).toMatchObject({
      version: 3,
      rewardEpochSeconds: "604800",
      unlockDelaySlots: "1512000",
    });
    expect(position).toMatchObject({
      version: 3,
      status: { inactive: 0, pending: 1, active: 2 },
    });
    expect(snapshot.version).toBe(3);
  });

  it("covers both Capital Offer terminal paths through exact typed actions", () => {
    const cancelled = [
      "initialize_capital_offer",
      "deposit_capital_offer",
      "cancel_capital_offer",
      "refund_cancelled_position",
    ] as const;
    const activated = [
      "bind_satcoin_vault",
      "initialize_capital_offer",
      "deposit_capital_offer",
      "activate_capital_offer",
      "record_vault_result",
      "claim_vault_sat",
      "request_vault_exit",
      "finalize_vault_exit",
    ] as const;
    const signer = deterministicKey(1);
    const requestIds = new Set<string>();
    for (const [pathName, actions] of [
      ["cancelled", cancelled],
      ["activated", activated],
    ] as const) {
      for (const [index, action] of actions.entries()) {
        const validated = validateAgentCapitalInstruction(instruction(action, signer), signer);
        requestIds.add(
          deriveAgentCapitalRequestId({
            walletId: "p4-owner",
            workflowId: `${pathName}-${index}-${action}`,
            instruction: validated,
          }),
        );
      }
    }
    expect(
      new Set([...cancelled, ...activated]),
      "both paths must cover every generated Agent Capital action",
    ).toEqual(new Set(FASED_AGENT_CAPITAL_CONTRACT.instructions.map((entry) => entry.action)));
    expect(requestIds.size).toBe(cancelled.length + activated.length);
  });

  it("keeps protected money unreachable and distinct binding signatures explicit", () => {
    const custody = fixtureBundle.valid.find(
      (fixture) => fixture.value.schema === "fased.sat-sol-pol-custody.v1",
    )?.value;
    expect(custody).toMatchObject({
      miningVaultPrincipalReachable: false,
      bondPrincipalReachable: false,
      keeperReserveReachable: false,
      pendingClaimsReachable: false,
      protectedAgentReserveReachable: false,
      ownerHotWalletCanWithdraw: false,
    });

    const profile = deterministicKey(1);
    const bind = instruction("bind_satcoin_vault", profile);
    bind.keys[1] = { ...bind.keys[1], pubkey: deterministicKey(30) };
    bind.keys[2] = { ...bind.keys[2], pubkey: deterministicKey(31) };
    expect(() => validateAgentCapitalInstruction(bind, profile)).toThrow(
      "multi-authority binding remains an explicit owner ceremony",
    );
  });
});
