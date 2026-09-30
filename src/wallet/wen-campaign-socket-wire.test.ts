import { mkdtemp, readFile, rm, chmod } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import type { CampaignReviewExpectation } from "./wen-campaign-review-contract.js";
import {
  createWenCampaignSocketTransport,
  recoverWenCampaignSocket,
} from "./wen-campaign-socket-approval.js";
afterEach(() => vi.restoreAllMocks());
it("uses a private Unix socket and restores the journey envelope without resending", async () => {
  const review = JSON.parse(
    await readFile(new URL("./fixtures/campaign-reviews/stop.json", import.meta.url), "utf8"),
  );
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(review.issuedAt) + 1);
  const a = review.semanticIntent;
  const expected: CampaignReviewExpectation = {
    requestId: review.requestId,
    walletId: review.walletId,
    walletPublicKey: review.walletPublicKey,
    policyHash: review.policyHash,
    program: a.Action.Program,
    economy: a.Action.Economy,
    position: a.Action.Position,
    operation: a.Action.Operation,
    amount: BigInt(a.Action.Amount),
    maxFee: BigInt(a.Binding.MaxFee),
    genesis: a.Pins.Genesis,
    codeSha256: a.Pins.CodeSHA256,
    deploymentSlot: BigInt(a.Pins.DeploymentSlot),
    upgradeAuthority: a.Pins.UpgradeAuthority,
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), "wen-campaign-wire-"));
  const socketPath = path.join(dir, "app.sock");
  const seen: string[] = [];
  let changed = false;
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      if (!buf.includes("\n")) {
        return;
      }
      const req = JSON.parse(buf.split("\n")[0]);
      seen.push(req.op + ":" + (req.request.action ?? "prepare"));
      if (req.op === "v2.wenCampaign.review.prepare") {
        socket.end(JSON.stringify({ ok: true, result: review }) + "\n");
        return;
      }
      if (req.request.action === "execute") {
        socket.end("{malformed\n");
        return;
      }
      socket.end(
        JSON.stringify({
          ok: true,
          result: {
            requestId: review.requestId,
            walletId: review.walletId,
            digest: changed ? "0".repeat(64) : review.artifactDigest.slice(7),
            outcome: "finalized-success",
            recoveryRequired: false,
          },
        }) + "\n",
      );
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    expect(
      await callLocalSocketSigner(socketPath, {
        op: "v2.wenCampaign.review.prepare",
        walletId: review.walletId,
        request: { requestId: review.requestId, draftSha256: "a".repeat(64) },
      }),
    ).toEqual(review);
    const profile = { walletId: review.walletId, socketPath, revision: "1" };
    const t = await createWenCampaignSocketTransport(
      review,
      expected,
      async () => profile,
      new AbortController().signal,
    );
    const execute = {
      requestId: review.requestId,
      action: "execute" as const,
      proof: { proofId: "test-proof" },
    };
    await expect(t.journey(execute)).rejects.toThrow();
    await expect(t.journey(execute)).rejects.toThrow("already attempted");
    expect(await t.journey({ requestId: review.requestId, action: "recover" })).toMatchObject({
      ok: true,
      result: { outcome: "finalized-success" },
    });
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(review.expiresAt) + 1000);
    expect(
      await recoverWenCampaignSocket(
        {
          requestId: review.requestId,
          walletId: review.walletId,
          digest: review.artifactDigest.slice(7),
        },
        async () => profile,
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true, result: { outcome: "finalized-success" } });
    changed = true;
    await expect(t.journey({ requestId: review.requestId, action: "recover" })).rejects.toThrow(
      "identity mismatch",
    );
    profile.revision = "2";
    await expect(t.journey({ requestId: review.requestId, action: "recover" })).rejects.toThrow(
      "profile changed",
    );
    expect(seen).toEqual([
      "v2.wenCampaign.review.prepare:prepare",
      "v2.wenCampaign.journey:execute",
      "v2.wenCampaign.journey:recover",
      "v2.wenCampaign.journey:recover",
      "v2.wenCampaign.journey:recover",
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
