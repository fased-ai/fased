import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { createLocalWenCampaignProfile } from "./wen-campaign-local-profile.js";
vi.mock("./providers/local-socket-signer-adapter.js", () => ({ callLocalSocketSigner: vi.fn() }));
it("requires a private explicit profile and rereads it before every action", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wen-campaign-profile-"));
  const file = path.join(dir, "profile.json");
  const config = {
    version: 1,
    mode: "local-candidate-only",
    socketPath: path.join(dir, "signer.sock"),
    draftSha256: "a".repeat(64),
    artifactDigest: "b".repeat(64),
    expected: {
      requestId: "request-123",
      walletId: "wallet",
      walletPublicKey: "pubkey",
      policyHash: "policy",
      program: "program",
      economy: "economy",
      position: "position",
      operation: "stop",
      amount: "0",
      maxFee: "100",
      genesis: "genesis",
      codeSha256: "c".repeat(64),
      deploymentSlot: "1",
      upgradeAuthority: null,
    },
  };
  try {
    await expect(createLocalWenCampaignProfile("relative.json")).rejects.toThrow();
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    await symlink(file, path.join(dir, "alias"));
    await expect(createLocalWenCampaignProfile(path.join(dir, "alias"))).rejects.toThrow();
    await chmod(file, 0o644);
    await expect(createLocalWenCampaignProfile(file)).rejects.toThrow("Unprotected");
    await chmod(file, 0o600);
    const profile = await createLocalWenCampaignProfile(file);
    await writeFile(file, JSON.stringify({ ...config, unexpected: true }));
    await expect(profile.runClaimJourney("request-123", "recover")).rejects.toThrow();
    expect(callLocalSocketSigner).not.toHaveBeenCalled();
    await writeFile(file, JSON.stringify(config));
    profile.stop();
    await expect(profile.runClaimJourney("request-123", "recover")).rejects.toThrow("stopped");
    expect(callLocalSocketSigner).not.toHaveBeenCalled();
    await writeFile(
      file,
      JSON.stringify({
        ...config,
        expected: { ...config.expected, amount: "18446744073709551616" },
      }),
    );
    await expect(createLocalWenCampaignProfile(file)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
