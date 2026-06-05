import { describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";
import { applyNonInteractiveGatewayConfig } from "./gateway-config.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
} as unknown as RuntimeEnv;

describe("non-interactive gateway config", () => {
  it("trusts loopback proxy headers for hosted Tailscale Serve", () => {
    const result = applyNonInteractiveGatewayConfig({
      nextConfig: {} as FasedAgentConfig,
      opts: {
        hostProfile: "hosting",
      } as OnboardOptions,
      runtime,
      defaultPort: 18789,
    });

    expect(result?.bind).toBe("loopback");
    expect(result?.tailscaleMode).toBe("serve");
    expect(result?.nextConfig.gateway?.trustedProxies).toEqual(["127.0.0.1/32", "::1/128"]);
  });
});
