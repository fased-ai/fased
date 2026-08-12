import { describe, expect, it } from "vitest";
import { assertConfigurationPreserved } from "./lifecycle-configuration-preservation.mjs";

const targetVersion = "0.1.76-rc.74";

function predecessorConfiguration() {
  return {
    gateway: {
      auth: { mode: "token", token: "synthetic-predecessor-token" },
      controlUi: { allowedOrigins: ["https://fixture.invalid"] },
      mode: "remote",
      remote: { token: "synthetic-predecessor-token" },
    },
    plugins: {
      allow: ["stable-bridge"],
      entries: { "stable-bridge": { enabled: true, config: { retention: 7 } } },
    },
  };
}

function canonicalTargetConfiguration() {
  return {
    agents: { defaults: { compaction: { mode: "safeguard" } } },
    commands: { native: "auto", nativeSkills: "auto", ownerDisplay: "raw", restart: true },
    gateway: {
      auth: { mode: "token", token: "synthetic-predecessor-token" },
      controlUi: { allowedOrigins: ["https://fixture.invalid"] },
      mode: "local",
      remote: { token: "synthetic-predecessor-token" },
    },
    meta: { lastTouchedAt: "2026-08-12T19:42:15.953Z", lastTouchedVersion: targetVersion },
    plugins: {
      allow: ["memory-core", "stable-bridge"],
      entries: { "stable-bridge": { enabled: true, config: { retention: 7 } } },
    },
  };
}

describe("lifecycle configuration preservation", () => {
  it("accepts the exact 0.1.75 Hosting canonicalization produced by the target", () => {
    expect(
      assertConfigurationPreserved({
        predecessor: predecessorConfiguration(),
        target: canonicalTargetConfiguration(),
        targetVersion,
        profile: "hosting",
      }),
    ).toMatchObject({ ok: true, profile: "hosting", targetVersion });
  });

  it("rejects removal or mutation of predecessor user settings", () => {
    const target = canonicalTargetConfiguration();
    target.gateway.auth.token = "changed";
    expect(() =>
      assertConfigurationPreserved({
        predecessor: predecessorConfiguration(),
        target,
        targetVersion,
        profile: "hosting",
      }),
    ).toThrow("undeclared configuration change at /gateway/auth/token");
  });

  it("rejects mutation of third-party plugin settings", () => {
    const target = canonicalTargetConfiguration();
    target.plugins.entries["stable-bridge"].config.retention = 8;
    expect(() =>
      assertConfigurationPreserved({
        predecessor: predecessorConfiguration(),
        target,
        targetVersion,
        profile: "hosting",
      }),
    ).toThrow("undeclared configuration change at /plugins/entries/stable-bridge/config/retention");
  });

  it("rejects unenumerated defaults and plugin allow additions", () => {
    const withUnknownDefault = canonicalTargetConfiguration();
    Object.assign(withUnknownDefault.commands, { shell: true });
    expect(() =>
      assertConfigurationPreserved({
        predecessor: predecessorConfiguration(),
        target: withUnknownDefault,
        targetVersion,
        profile: "hosting",
      }),
    ).toThrow("undeclared configuration change at /commands");

    const withUnknownPlugin = canonicalTargetConfiguration();
    withUnknownPlugin.plugins.allow.push("sat-mining");
    expect(() =>
      assertConfigurationPreserved({
        predecessor: predecessorConfiguration(),
        target: withUnknownPlugin,
        targetVersion,
        profile: "hosting",
      }),
    ).toThrow("target added undeclared plugin allow entry sat-mining");
  });
});
