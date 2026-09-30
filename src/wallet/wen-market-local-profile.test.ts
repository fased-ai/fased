import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { createLocalWenMarketProfile } from "./wen-campaign-local-profile.js";
vi.mock("./providers/local-socket-signer-adapter.js", () => ({ callLocalSocketSigner: vi.fn() }));
it("binds Buy selections, rejects malformed limits, and stops recovery without signing", async () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/market-reviews/buy.json", import.meta.url), "utf8"),
  );
  const a = fixture.semanticIntent;
  const dir = await mkdtemp(path.join(tmpdir(), "wen-market-profile-"));
  const file = path.join(dir, "profile.json");
  const config = {
    version: 1,
    mode: "local-candidate-only",
    socketPath: path.join(dir, "signer.sock"),
    draftSha256: "a".repeat(64),
    artifactDigest: fixture.artifactDigest.slice(7),
    expected: {
      requestId: fixture.requestId,
      walletId: fixture.walletId,
      walletPublicKey: fixture.walletPublicKey,
      policyHash: fixture.policyHash,
      pins: a.Pins,
      policy: a.Policy,
      limits: a.Limits,
      maxFee: String(a.Binding.MaxFee),
      retainedLamports: String(a.Binding.RetainedLamports),
    },
  };
  try {
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    const profile = await createLocalWenMarketProfile(file);
    const selected = await profile.readCampaignSelection();
    expect(selected.expected.requestId).toBe(fixture.requestId);
    await chmod(file, 0o644);
    await expect(profile.readCampaignSelection()).rejects.toThrow("Unprotected");
    await chmod(file, 0o600);
    await writeFile(
      file,
      JSON.stringify({
        ...config,
        expected: {
          ...config.expected,
          limits: { ...a.Limits, MaxCash: Number.MAX_SAFE_INTEGER + 1 },
        },
      }),
    );
    await expect(profile.readCampaignSelection()).rejects.toThrow();
    await writeFile(file, JSON.stringify(config));
    profile.stop();
    await expect(profile.runClaimJourney(fixture.requestId, "recover")).rejects.toThrow("stopped");
    expect(callLocalSocketSigner).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
