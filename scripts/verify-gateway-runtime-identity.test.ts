import { describe, expect, it } from "vitest";
import { assertGatewayRuntimeIdentity } from "./verify-gateway-runtime-identity.mjs";

describe("Gateway runtime identity verification", () => {
  it("accepts the expected managed runtime", () => {
    expect(() =>
      assertGatewayRuntimeIdentity(
        { version: "0.1.60", runtimeSource: "managed-package" },
        "0.1.60",
      ),
    ).not.toThrow();
  });

  it("rejects a stale Gateway version", () => {
    expect(() =>
      assertGatewayRuntimeIdentity(
        { version: "0.1.23", runtimeSource: "source-checkout" },
        "0.1.60",
      ),
    ).toThrow("does not match installed CLI");
  });

  it("rejects a source checkout even when its package version looks current", () => {
    expect(() =>
      assertGatewayRuntimeIdentity(
        { version: "0.1.60", runtimeSource: "source-checkout" },
        "0.1.60",
      ),
    ).toThrow("is not a managed packaged runtime");
  });

  it("accepts a matching source checkout only when explicitly allowed", () => {
    expect(() =>
      assertGatewayRuntimeIdentity(
        { version: "0.1.60", runtimeSource: "source-checkout" },
        "0.1.60",
        { allowSourceCheckout: true },
      ),
    ).not.toThrow();
  });

  it("rejects a matching version with no managed runtime identity", () => {
    expect(() => assertGatewayRuntimeIdentity({ version: "0.1.60" }, "0.1.60")).toThrow(
      "runtime source unknown",
    );
  });
});
