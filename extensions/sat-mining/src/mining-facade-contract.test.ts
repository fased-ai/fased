import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSatMiningGatewayMethodRegistrations,
  registerSatMiningGatewayMethods,
  SAT_MINING_METHOD_INVENTORY,
  type SatMiningGatewayMethodHandlerRegistration,
  type SatMiningGatewayMethodRegistration,
} from "fased/plugin-sdk/sat-runtime";
import { describe, expect, it, vi } from "vitest";

const extensionImplementationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "implementation.ts",
);

function readRegistrations(source: string): SatMiningGatewayMethodRegistration[] {
  const patterns: Array<{ kind: SatMiningGatewayMethodRegistration["kind"]; name: string }> = [
    { kind: "read", name: "registerSatReadMethod" },
    { kind: "mutation", name: "registerSatMutationMethod" },
    { kind: "mutation", name: "registerSatSubmissionMethod" },
  ];
  return patterns.flatMap(({ kind, name }) => {
    const expression = new RegExp(`${name}\\s*\\(\\s*["'](sat\\.[^"']+)["']`, "g");
    return [...source.matchAll(expression)].map((match) => ({ method: match[1]!, kind }));
  });
}

describe("sat-mining Mining facade registration contract", () => {
  it("registers each and only facade method with its canonical classification", () => {
    const source = fs.readFileSync(extensionImplementationPath, "utf8");
    const registrations = readRegistrations(source);

    expect(registrations).toHaveLength(SAT_MINING_METHOD_INVENTORY.length);
    expect(() => assertSatMiningGatewayMethodRegistrations(registrations)).not.toThrow();
    expect(source).not.toMatch(/api\.registerGatewayMethod\s*\(\s*["']sat\./);
    expect(source).not.toMatch(/from\s+["'][^"']*\.\.\/src\//);
  });

  it("does not install partial Gateway registrations when the staged inventory drifts", () => {
    const staged: SatMiningGatewayMethodHandlerRegistration<() => void>[] =
      SAT_MINING_METHOD_INVENTORY.map((registration) => ({ ...registration, handler: () => {} }));
    const cases = [
      staged.slice(1),
      [...staged, { ...staged[0]!, handler: () => {} }],
      [...staged, { method: "sat.unknown", kind: "read" as const, handler: () => {} }],
      staged.map((registration) =>
        registration.method === "sat.getMiningStatus"
          ? { ...registration, kind: "mutation" as const }
          : registration,
      ),
    ];

    for (const registrations of cases) {
      const registerGatewayMethod = vi.fn();
      expect(() => registerSatMiningGatewayMethods(registrations, registerGatewayMethod)).toThrow();
      expect(registerGatewayMethod).not.toHaveBeenCalled();
    }
  });
});
