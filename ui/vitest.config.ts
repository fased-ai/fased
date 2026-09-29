import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  optimizeDeps: {
    include: [
      "@noble/ed25519",
      "@solana/wallet-standard-features",
      "@solana/web3.js",
      "@wallet-standard/app",
      "@wallet-standard/features",
      "dompurify",
      "lit/decorators.js",
      "lit/directives/if-defined.js",
      "lit/directives/ref.js",
      "lit/directives/repeat.js",
      "lit/directives/unsafe-html.js",
      "marked",
    ],
  },
  test: {
    include: ["src/**/*.browser.test.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium", name: "chromium" }],
      headless: true,
      ui: false,
    },
  },
});
