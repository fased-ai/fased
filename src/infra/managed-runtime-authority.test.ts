import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isManagedLifecycleRuntime } from "./managed-runtime-authority.js";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { force: true, recursive: true });
  }
});

function managedFixture(profile: "hosting" | "local") {
  const anchor = fs.mkdtempSync(path.join(os.tmpdir(), "fased-managed-authority-"));
  fixtures.push(anchor);
  fs.chmodSync(anchor, 0o755);
  const generation = "a".repeat(64);
  const root =
    profile === "hosting"
      ? path.join(anchor, "fased", "generations", generation, "payload", "runtime")
      : path.join(
          anchor,
          "fased",
          "local",
          "0123456789abcdef",
          "generations",
          generation,
          "payload",
          "runtime",
        );
  fs.mkdirSync(path.join(root, "dist", "infra"), { mode: 0o755, recursive: true });
  const modulePath = path.join(root, "dist", "infra", "managed-runtime-authority.js");
  fs.writeFileSync(modulePath, "export {};\n", { mode: 0o444 });
  return { anchor, modulePath, runtimeRoot: root };
}

describe("managed runtime authority", () => {
  it("fails closed for a managed runtime claim", () => {
    expect(
      isManagedLifecycleRuntime({
        env: { FASED_RUNTIME_SOURCE: "go-lifecycle" },
        moduleUrl: import.meta.url,
      }),
    ).toBe(true);
  });

  it.each(["hosting", "local"] as const)(
    "recognizes a trusted root-owned %s generation without launcher environment",
    (profile) => {
      const fixture = managedFixture(profile);
      expect(
        isManagedLifecycleRuntime({
          env: {},
          expectedUid: process.getuid?.() ?? 0,
          managedRootAnchor: fixture.anchor,
          moduleUrl: pathToFileURL(fixture.modulePath).href,
        }),
      ).toBe(true);
    },
  );

  it("rejects a writable generation component", () => {
    const fixture = managedFixture("hosting");
    fs.chmodSync(fixture.runtimeRoot, 0o777);
    expect(
      isManagedLifecycleRuntime({
        env: {},
        expectedUid: process.getuid?.() ?? 0,
        managedRootAnchor: fixture.anchor,
        moduleUrl: pathToFileURL(fixture.modulePath).href,
      }),
    ).toBe(false);
  });

  it("does not classify a source checkout without a managed claim", () => {
    expect(isManagedLifecycleRuntime({ env: {}, moduleUrl: import.meta.url })).toBe(false);
  });
});
