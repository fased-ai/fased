import { describe, expect, it } from "vitest";
import {
  assertSatMiningGatewayMethodRegistrations,
  isSatMiningMutationMethod,
  SAT_MINING_GATEWAY_METHODS,
  SAT_MINING_METHOD_INVENTORY,
  SAT_MINING_MUTATION_METHODS,
  SAT_MINING_READ_METHODS,
} from "./mining-facade.js";

describe("SAT Mining Gateway facade", () => {
  it("contains the exact registered method inventory with one classification per method", () => {
    expect(SAT_MINING_METHOD_INVENTORY).toHaveLength(58);
    expect(SAT_MINING_GATEWAY_METHODS).toHaveLength(58);
    expect(new Set(SAT_MINING_GATEWAY_METHODS)).toHaveLength(58);
    expect(SAT_MINING_MUTATION_METHODS.size + SAT_MINING_READ_METHODS.size).toBe(58);
    expect(isSatMiningMutationMethod("sat.startMining")).toBe(true);
    expect(isSatMiningMutationMethod("sat.getMiningStatus")).toBe(false);
  });

  it("rejects missing, duplicate, undeclared, and misclassified registrations", () => {
    const registrations = [...SAT_MINING_METHOD_INVENTORY];
    expect(() => assertSatMiningGatewayMethodRegistrations(registrations.slice(1))).toThrow(
      "missing SAT Mining Gateway method registrations: sat.abortEmptyCycle",
    );
    expect(() =>
      assertSatMiningGatewayMethodRegistrations([
        ...registrations,
        { method: "sat.startMining", kind: "mutation" },
      ]),
    ).toThrow("duplicate SAT Mining Gateway method registration: sat.startMining");
    expect(() =>
      assertSatMiningGatewayMethodRegistrations([
        ...registrations,
        { method: "sat.unknown", kind: "read" },
      ]),
    ).toThrow("undeclared SAT Mining Gateway method registration: sat.unknown");
    expect(() =>
      assertSatMiningGatewayMethodRegistrations(
        registrations.map((registration) =>
          registration.method === "sat.getMiningStatus"
            ? { ...registration, kind: "mutation" as const }
            : registration,
        ),
      ),
    ).toThrow(
      "SAT Mining Gateway method classification mismatch for sat.getMiningStatus: expected read, received mutation",
    );
  });
});
