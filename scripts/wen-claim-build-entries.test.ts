import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const required = [
  "wallet/wen-native-claim-preparation",
  "wallet/wen-native-claim-preparation-contract",
  "wallet/wen-btc-claim-preparation",
  "wallet/wen-btc-claim-preparation-contract",
  "wallet/wen-withdrawal-preparation",
];
describe("WEN claim package entries", () => {
  for (const [graph, profile] of [
    ["", ""],
    ["core", ""],
    ["", "vps-lite"],
    ["core", "vps-lite"],
  ]) {
    it(`preserves client entry identities in ${graph || "default"}/${profile || "ordinary"}`, () => {
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
        import configs from './tsdown.config.ts';
        const entries = Object.assign({}, ...configs.map(c => typeof c.entry === 'object' && !Array.isArray(c.entry) ? c.entry : {}));
        console.log(JSON.stringify(entries));
      `,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 15000,
          env: { ...process.env, FASED_BUILD_GRAPH: graph, FASED_BUILD_PROFILE: profile },
        },
      );
      const entries = JSON.parse(output);
      for (const name of required) {
        expect(entries[name]).toBe(`src/${name}.ts`);
      }
    });
  }
});
