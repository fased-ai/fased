import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("lifecycle root-head publication", () => {
  it("keeps every attestation readback on a verifier-supported JSON path", async () => {
    const publisher = await readFile(
      resolve(repoRoot, "scripts/publish-lifecycle-root-head.sh"),
      "utf8",
    );

    expect(publisher).toContain('"$workspace/current-$attestation_name"');
    expect(publisher).toContain('"$workspace/final-$attestation_name"');
    expect(publisher).not.toContain('"$workspace/current-attestation"');
    expect(publisher).not.toContain('"$workspace/final-attestation"');
  });
});
