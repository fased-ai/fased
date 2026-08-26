import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  walletProviderFacade,
  walletReadinessFacade,
  walletRegistryFacade,
} from "../../../src/plugin-sdk/sat-runtime.js";

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("Mining Wallet and recovery boundaries", () => {
  it("consumes the completed Wallet facades through the plugin SDK", () => {
    expect(typeof walletProviderFacade.createAdapter).toBe("function");
    expect(typeof walletReadinessFacade.read).toBe("function");
    expect(typeof walletRegistryFacade.read).toBe("function");

    const pluginSdk = source("../../../src/plugin-sdk/sat-runtime.ts");
    expect(pluginSdk).toContain('from "../wallet/wallet-provider-facade.js"');
    expect(pluginSdk).toContain('from "../wallet/wallet-readiness-facade.js"');
    expect(pluginSdk).toContain('from "../wallet/wallet-registry-facade.js"');

    const mining = source("../implementation.ts");
    const sdkImport =
      mining.match(/import \{[\s\S]*?\} from "fased\/plugin-sdk\/sat-runtime";/u)?.[0] ?? "";
    expect(sdkImport).toContain("walletProviderFacade");
    expect(sdkImport).toContain("walletReadinessFacade");
    expect(sdkImport).toContain("walletRegistryFacade");
    expect(sdkImport).not.toMatch(/\bcreateWalletProviderAdapter\b/);
    expect(sdkImport).not.toMatch(/\breadWalletProviderRegistry\b/);
    expect(sdkImport).not.toMatch(/\breadWalletStatusSnapshot\b/);
    expect(sdkImport).not.toMatch(/\bresolveWalletUserRole\b/);
    expect(sdkImport).not.toMatch(/\bupsertNamedWallet\b/);
  });

  it("keeps recovery mutation decisions outside the polling service", () => {
    const service = source("./recovery-service.ts");
    const orchestrator = source("./recovery-orchestrator.ts");
    expect(service).toContain("createSatRecoveryOrchestrator");
    expect(service).not.toContain('method: "sat.revealCycle"');
    expect(service).not.toContain('method: "sat.releaseUnrevealedCommit"');
    expect(service).not.toContain('method: "sat.closeResolvedCycleAccounts"');
    expect(service).not.toContain('stage === "submitted"');
    expect(service).not.toContain("shouldCompactPendingRange");
    expect(service).not.toContain("collectPrioritizedCloseCycleIds");
    expect(orchestrator).toContain('method: "sat.revealCycle"');
    expect(orchestrator).toContain('method: "sat.releaseUnrevealedCommit"');
    expect(orchestrator).toContain('method: "sat.closeResolvedCycleAccounts"');
    expect(orchestrator).toContain('stage === "submitted"');
    expect(orchestrator).toContain("shouldCompactPendingRange");
    expect(orchestrator).toContain("collectPrioritizedCloseCycleIds");
    expect(orchestrator).not.toMatch(/privateKey|secretKey|seedPhrase|mnemonic/u);
  });
});
