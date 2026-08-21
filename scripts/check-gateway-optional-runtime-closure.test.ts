import { describe, expect, it } from "vitest";
import {
  assertGatewayOptionalRuntimeClosure,
  collectGatewayStaticClosure,
} from "./check-gateway-optional-runtime-closure.js";

describe("Gateway optional-runtime static closure", () => {
  it("retains provider facades and excludes operational implementations", async () => {
    const closure = await assertGatewayOptionalRuntimeClosure();
    expect(closure).toContain("src/media/runtime-service.ts");
    expect(closure).toContain("src/tts/runtime-service.ts");
    expect(closure).toContain("src/infra/outbound/deliver.ts");
    expect(closure).toContain("src/agents/pi-ai-compat-runtime.ts");
    expect(closure).not.toContain("src/media/fetch.ts");
    expect(closure).not.toContain("src/media/image-ops.ts");
    expect(closure).not.toContain("src/media/store.ts");
    expect(closure).not.toContain("src/web/media.ts");
    expect(closure).not.toContain("src/tts/tts.ts");
    expect(closure).not.toContain("src/signal/send.ts");
  });

  it("is deterministic", async () => {
    await expect(collectGatewayStaticClosure()).resolves.toEqual(
      await collectGatewayStaticClosure(),
    );
  });
});
