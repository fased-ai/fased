import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __testing, normalizeOwnerPolicy } from "./fased-signer-owner-policy.mjs";

const templateRoot = path.join(process.cwd(), "config", "signer-policies");
const templateNames = ["agent.json.template", "mining.json.template", "vault.json.template"];

function fillTemplate(raw: string) {
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  const placeholders = [...new Set(raw.match(/REPLACE_WITH_[A-Z0-9_]+/gu) ?? [])].toSorted(compare);
  const replacements = new Map<string, string>();
  let addressIndex = 1;
  let capIndex = 1;
  for (const placeholder of placeholders) {
    if (placeholder.includes("POSITIVE_")) {
      replacements.set(placeholder, String(capIndex));
      capIndex += 1;
      continue;
    }
    replacements.set(placeholder, __testing.encodeBase58(Buffer.alloc(32, addressIndex)));
    addressIndex += 1;
  }
  let filled = raw;
  for (const [placeholder, value] of replacements) {
    filled = filled.replaceAll(placeholder, value);
  }
  return { filled, placeholders };
}

describe("packaged native signer policy templates", () => {
  it("ships exactly the documented Agent, Mining, and Vault starter templates", async () => {
    const entries = (await fsp.readdir(templateRoot)).filter((entry) =>
      entry.endsWith(".json.template"),
    );
    expect(entries.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))).toEqual(
      templateNames,
    );
    const readme = await fsp.readFile(path.join(templateRoot, "README.md"), "utf8");
    expect(readme).toContain("deliberately inactive templates");
    expect(readme).toContain("deny-all");
    expect(readme).toContain("does not enable signing");
  });

  it.each(templateNames)(
    "keeps the unmodified %s template invalid and placeholder-bound",
    async (name) => {
      const raw = await fsp.readFile(path.join(templateRoot, name), "utf8");
      const strict = __testing.parseStrictJson(Buffer.from(raw), name);
      expect(() => normalizeOwnerPolicy(strict)).toThrow();
      const { filled, placeholders } = fillTemplate(raw);
      expect(placeholders.length).toBeGreaterThan(0);
      expect(filled).not.toContain("REPLACE_WITH_");
      expect(placeholders.some((placeholder) => placeholder.includes("POSITIVE_"))).toBe(true);
      const normalized = normalizeOwnerPolicy(
        __testing.parseStrictJson(Buffer.from(filled), `filled ${name}`),
      );
      expect(normalized.walletId).toBe(name.replace(".json.template", ""));
      expect(normalized.operations.length).toBeGreaterThan(0);
      expect(normalized.programs.length).toBeGreaterThan(0);
      expect(normalized.assets.every((asset) => BigInt(asset.maxPerTx) > 0n)).toBe(true);
      expect(
        normalized.assets.every((asset) => BigInt(asset.maxDaily) >= BigInt(asset.maxPerTx)),
      ).toBe(true);
    },
  );

  it("keeps Agent typed, Mining program-bound, and Vault reviewed without broad Jupiter defaults", async () => {
    const policies = await Promise.all(
      templateNames.map(async (name) => {
        const raw = await fsp.readFile(path.join(templateRoot, name), "utf8");
        const { filled } = fillTemplate(raw);
        return normalizeOwnerPolicy(__testing.parseStrictJson(Buffer.from(filled), name));
      }),
    );
    const [agent, mining, vault] = policies;
    expect(agent.operations).toEqual(["solana.nativeTransfer", "solana.splTransferChecked"]);
    expect(mining.operations.some((operation) => operation.startsWith("sat.commitCycle@"))).toBe(
      true,
    );
    expect(mining.operations).toContain("solana.nativeTransfer");
    expect(mining.operations).toContain("solana.splTransferChecked");
    expect(vault.operations).toContain("federation.bondChallenge");
    expect(vault.operations.some((operation) => operation.startsWith("vaultBond."))).toBe(true);
    for (const policy of policies) {
      expect(policy.operations.some((operation) => operation.includes("signTx"))).toBe(false);
      expect(policy.operations.some((operation) => operation.includes("jupiter"))).toBe(false);
      expect(policy.operations).not.toContain("solana.satAction");
      expect(policy.operations).not.toContain("solana.vaultBondAction");
    }
  });

  it("is included through the existing packaged config directory", async () => {
    const packageJSON = JSON.parse(
      await fsp.readFile(path.join(process.cwd(), "package.json"), "utf8"),
    );
    expect(packageJSON.files).toContain("config/");
  });
});
