import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandHomePrefix, resolveEffectiveHomeDir, resolveRequiredHomeDir } from "./home-dir.js";

describe("resolveEffectiveHomeDir", () => {
  it("prefers FASED_HOME over HOME and USERPROFILE", () => {
    const env = {
      FASED_HOME: "/srv/fased-home",
      HOME: "/home/other",
      USERPROFILE: "C:/Users/other",
    } as NodeJS.ProcessEnv;

    expect(resolveEffectiveHomeDir(env, () => "/fallback")).toBe(path.resolve("/srv/fased-home"));
  });

  it("falls back to HOME then USERPROFILE then homedir", () => {
    expect(resolveEffectiveHomeDir({ HOME: "/home/alice" } as NodeJS.ProcessEnv)).toBe(
      path.resolve("/home/alice"),
    );
    expect(resolveEffectiveHomeDir({ USERPROFILE: "C:/Users/alice" } as NodeJS.ProcessEnv)).toBe(
      path.resolve("C:/Users/alice"),
    );
    expect(resolveEffectiveHomeDir({} as NodeJS.ProcessEnv, () => "/fallback")).toBe(
      path.resolve("/fallback"),
    );
  });

  it("expands FASED_HOME when set to ~", () => {
    const env = {
      FASED_HOME: "~/svc",
      HOME: "/home/alice",
    } as NodeJS.ProcessEnv;

    expect(resolveEffectiveHomeDir(env)).toBe(path.resolve("/home/alice/svc"));
  });
});

describe("resolveRequiredHomeDir", () => {
  it("returns cwd when no home source is available", () => {
    expect(
      resolveRequiredHomeDir({} as NodeJS.ProcessEnv, () => {
        throw new Error("no home");
      }),
    ).toBe(process.cwd());
  });

  it("returns a fully resolved path for FASED_HOME", () => {
    const result = resolveRequiredHomeDir(
      { FASED_HOME: "/custom/home" } as NodeJS.ProcessEnv,
      () => "/fallback",
    );
    expect(result).toBe(path.resolve("/custom/home"));
  });

  it("returns cwd when FASED_HOME is tilde-only and no fallback home exists", () => {
    expect(
      resolveRequiredHomeDir({ FASED_HOME: "~" } as NodeJS.ProcessEnv, () => {
        throw new Error("no home");
      }),
    ).toBe(process.cwd());
  });
});

describe("expandHomePrefix", () => {
  it("expands tilde using effective home", () => {
    const value = expandHomePrefix("~/x", {
      env: { FASED_HOME: "/srv/fased-home" } as NodeJS.ProcessEnv,
    });
    expect(value).toBe(`${path.resolve("/srv/fased-home")}/x`);
  });

  it("keeps non-tilde values unchanged", () => {
    expect(expandHomePrefix("/tmp/x")).toBe("/tmp/x");
  });
});
