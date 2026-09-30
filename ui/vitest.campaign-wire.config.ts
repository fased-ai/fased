import { playwright, defineBrowserCommand } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { startCampaignWireFixture } from "./test/wen-campaign-wire-fixture.js";
let authenticatorCleanup: (() => Promise<void>) | undefined;
let fixture: Awaited<ReturnType<typeof startCampaignWireFixture>> | undefined;
export default defineConfig({
  optimizeDeps: { include: ["@solana/web3.js"] },
  test: {
    fileParallelism: false,
    testTimeout: 120000,
    include: [
      "src/ui/views/wen-campaign-wire.browser.test.ts",
      "src/ui/views/wen-bond-claim-wire.browser.test.ts",
      "src/ui/views/wen-bond-purchase-wire.browser.test.ts",
    ],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      headless: true,
      ui: false,
      commands: {
        campaignWireStart: defineBrowserCommand(
          async (ctx, origin: string, operation?: "bond-claim" | "bond-purchase") => {
            const cdp = await ctx.context.newCDPSession(ctx.page);
            await cdp.send("WebAuthn.enable");
            const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
              options: {
                protocol: "ctap2",
                transport: "internal",
                hasResidentKey: true,
                hasUserVerification: true,
                isUserVerified: true,
                automaticPresenceSimulation: true,
              },
            });
            authenticatorCleanup = async () => {
              await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
              await cdp.detach();
            };
            if (fixture) {
              await fixture.stop();
            }
            try {
              fixture = await startCampaignWireFixture(origin, operation);
            } catch (error) {
              await authenticatorCleanup?.();
              authenticatorCleanup = undefined;
              throw error;
            }
            return fixture.url;
          },
        ),
        campaignWireStop: defineBrowserCommand(async () => {
          const current = fixture;
          fixture = undefined;
          try {
            await current?.stop();
            return current?.events ?? [];
          } finally {
            await authenticatorCleanup?.();
            authenticatorCleanup = undefined;
          }
        }),
      },
    },
  },
});
