import { describe, expect, it } from "vitest";
import {
  SAT_BOND_INSTRUCTION_DISCRIMINATORS,
  SAT_INSTRUCTION_DISCRIMINATORS,
} from "./src/protocol-contract.js";
import { resolveSatSignerCodec, SAT_SIGNER_ACTIONS } from "./src/signer-codec-manifest.js";

const MAIN_PROGRAM = "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75";
const BOND_PROGRAM = "D1ySMMiJmvJRhJJKwYnc171w3g2JDPQnkgD8kGhaG4Vq";

describe("SAT protocol-v2 signer codec manifest", () => {
  it("resolves named main and dedicated-bond actions only for their configured program family", () => {
    expect(
      resolveSatSignerCodec({
        programId: MAIN_PROGRAM,
        mainProgramId: MAIN_PROGRAM,
        bondProgramId: BOND_PROGRAM,
        data: Buffer.concat([
          Buffer.from([SAT_INSTRUCTION_DISCRIMINATORS.depositMinerCapital]),
          Buffer.alloc(8, 1),
        ]),
      }).action,
    ).toBe("depositMinerCapital");
    expect(
      resolveSatSignerCodec({
        programId: BOND_PROGRAM,
        mainProgramId: MAIN_PROGRAM,
        bondProgramId: BOND_PROGRAM,
        data: Buffer.concat([
          Buffer.from([SAT_BOND_INSTRUCTION_DISCRIMINATORS.openBondPosition]),
          Buffer.alloc(8, 1),
        ]),
      }).action,
    ).toBe("openBondPosition");
    expect(new Set(SAT_SIGNER_ACTIONS).size).toBe(41);
  });

  it("rejects unknown programs, action-family mismatches, malformed lengths and batch headers", () => {
    expect(() =>
      resolveSatSignerCodec({
        programId: "11111111111111111111111111111111",
        mainProgramId: MAIN_PROGRAM,
        bondProgramId: BOND_PROGRAM,
        data: Buffer.alloc(9),
      }),
    ).toThrow("unconfigured program");
    expect(() =>
      resolveSatSignerCodec({
        programId: BOND_PROGRAM,
        mainProgramId: MAIN_PROGRAM,
        bondProgramId: BOND_PROGRAM,
        data: Buffer.concat([
          Buffer.from([SAT_INSTRUCTION_DISCRIMINATORS.depositMinerCapital]),
          Buffer.alloc(8),
        ]),
      }),
    ).toThrow("no typed action");
    expect(() =>
      resolveSatSignerCodec({
        programId: MAIN_PROGRAM,
        mainProgramId: MAIN_PROGRAM,
        bondProgramId: BOND_PROGRAM,
        data: Buffer.from([SAT_INSTRUCTION_DISCRIMINATORS.depositMinerCapital]),
      }),
    ).toThrow("payload must contain 9 bytes");
    expect(() =>
      resolveSatSignerCodec({
        programId: MAIN_PROGRAM,
        mainProgramId: MAIN_PROGRAM,
        bondProgramId: BOND_PROGRAM,
        data: Buffer.concat([
          Buffer.from([SAT_INSTRUCTION_DISCRIMINATORS.claimCycleRewardsBatch, 2]),
          Buffer.alloc(7),
          Buffer.alloc(8),
        ]),
      }),
    ).toThrow("item count does not match");
  });
});
