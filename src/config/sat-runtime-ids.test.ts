import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SAT_RUNTIME_DEFAULTS,
  resolveSatRuntimeIds,
  tryResolveSatRuntimeIds,
} from "./sat-runtime-ids.js";

const ENV_KEYS = [
  "FASED_SAT_PROGRAM_ID",
  "FASED_SAT_BOND_PROGRAM_ID",
  "FASED_SAT_MINT_ADDRESS",
  "FASED_SAT_MINT_PROGRAM_ID",
] as const;

describe("sat runtime defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  it("has no bundled SAT runtime IDs before public mainnet sync", () => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    expect(SAT_RUNTIME_DEFAULTS).toBeNull();
    expect(tryResolveSatRuntimeIds({})).toBeNull();
    expect(() => resolveSatRuntimeIds({})).toThrow(/SAT runtime IDs are not configured/);
  });

  it("honors explicit env overrides", () => {
    expect(
      resolveSatRuntimeIds({
        FASED_SAT_PROGRAM_ID: "sat-program",
        FASED_SAT_BOND_PROGRAM_ID: "sat-bond",
        FASED_SAT_MINT_ADDRESS: "sat-mint",
        FASED_SAT_MINT_PROGRAM_ID: "sat-mint-program",
      }),
    ).toEqual({
      programId: "sat-program",
      bondProgramId: "sat-bond",
      mintAddress: "sat-mint",
      mintProgramId: "sat-mint-program",
    });
  });

  it("can import with only explicit env and no repo-local SAT runtime file", async () => {
    vi.stubEnv("FASED_SAT_PROGRAM_ID", "sat-program");
    vi.stubEnv("FASED_SAT_BOND_PROGRAM_ID", "sat-bond");
    vi.stubEnv("FASED_SAT_MINT_ADDRESS", "sat-mint");
    vi.stubEnv("FASED_SAT_MINT_PROGRAM_ID", "sat-mint-program");
    vi.stubEnv("FASED_SAT_RUNTIME_ENV_FILE", "/tmp/does-not-exist-sat-runtime.env");
    vi.resetModules();
    const mod = await import("./sat-runtime-ids.js");
    expect(mod.SAT_RUNTIME_DEFAULTS).toEqual({
      programId: "sat-program",
      bondProgramId: "sat-bond",
      mintAddress: "sat-mint",
      mintProgramId: "sat-mint-program",
    });
  });
});
