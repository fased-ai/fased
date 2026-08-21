import { describe, expect, it } from "vitest";
import {
  MANAGED_RUNTIME_SPECIFIER_PREFIX,
  managedRuntimeSpecifier,
} from "./managed-runtime-aliases.js";

describe("managed component core facade inventory", () => {
  it("maps only exact core facade modules", () => {
    expect(managedRuntimeSpecifier("src/config/config.ts")).toBe(
      `${MANAGED_RUNTIME_SPECIFIER_PREFIX}config/config`,
    );
    expect(managedRuntimeSpecifier("src/gateway/protocol/index.js")).toBe(
      `${MANAGED_RUNTIME_SPECIFIER_PREFIX}gateway/protocol/index`,
    );
    expect(managedRuntimeSpecifier("src/browser/control-service.ts")).toBeNull();
    expect(managedRuntimeSpecifier("../src/config/config.ts")).toBeNull();
  });
});
