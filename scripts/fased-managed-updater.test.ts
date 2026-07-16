import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRE_V2_HOSTING_MIGRATION_MESSAGE, __testing } from "./fased-managed-updater.mjs";

const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";

async function withUnixServer(handler: (socket: net.Socket) => void) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-managed-updater-test-"));
  const socketPath = path.join(root, "request.sock");
  const server = net.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await fsp.chmod(socketPath, 0o660);
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

function transaction(phase = "prepared") {
  return {
    schemaVersion: 1,
    transactionId: TRANSACTION_ID,
    targetVersion: "1.2.3",
    previousVersion: "1.2.2",
    targetRoot: "/managed/releases/1.2.3",
    previousRoot: "/managed/releases/1.2.2",
    nextManifest: { profile: "hosting", runtime: { activeVersion: "1.2.3" } },
    previousManifest: { profile: "hosting", runtime: { activeVersion: "1.2.2" } },
    phase,
  };
}

function transactionOperations(events: string[], overrides: Record<string, unknown> = {}) {
  return {
    activateApplication: async () => events.push("activate-app"),
    restoreApplication: async () => events.push("restore-app"),
    quiesceGateway: async () => events.push("quiesce-gateway"),
    signerRequest: async (operation: string) => events.push(`signer:${operation}`),
    verifyGateway: async () => events.push("verify-gateway"),
    refreshPrevious: async () => events.push("refresh-previous"),
    finalizeApplication: async () => events.push("finalize-app"),
    writePhase: async (journal: ReturnType<typeof transaction>, phase: string) => {
      events.push(`write:${phase}`);
      return { ...journal, phase };
    },
    removeJournal: async () => events.push("remove-journal"),
    ...overrides,
  };
}

describe("stable managed updater", () => {
  it("handles status and ordinary managed update commands", () => {
    expect(__testing.parseArgs(["update", "status", "--json"])).toMatchObject({
      delegate: false,
      options: { status: true, json: true, channel: null },
    });
    expect(__testing.parseArgs(["update", "--channel", "stable"])).toMatchObject({
      delegate: false,
      options: { status: false, channel: "stable" },
    });
    expect(__testing.parseArgs(["update", "--dry-run"])).toMatchObject({
      delegate: false,
      options: { dryRun: true },
    });
  });

  it("delegates dev and non-transactional update subcommands to the active runtime", () => {
    expect(__testing.parseArgs(["update", "--channel", "dev"]).delegate).toBe(true);
    expect(__testing.parseArgs(["update", "wizard"]).delegate).toBe(true);
  });

  it("compares semantic versions without lexical ordering mistakes", () => {
    expect(__testing.compareVersions("0.1.9", "0.1.10")).toBe(-1);
    expect(__testing.compareVersions("0.1.59", "0.1.59")).toBe(0);
    expect(__testing.compareVersions("0.2.0", "0.1.59")).toBe(1);
    expect(__testing.compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(__testing.compareVersions("1.0.0-beta.10", "1.0.0")).toBe(-1);
    expect(__testing.compareVersions("1.0.0", "1.0.0-beta.10")).toBe(1);
  });

  it("rejects release archive paths that can escape the approved root", () => {
    expect(__testing.archiveEntryIsSafe("package/", "package")).toBe(true);
    expect(__testing.archiveEntryIsSafe("package/dist/entry.js", "package")).toBe(true);
    expect(__testing.archiveEntryIsSafe("package/../escape", "package")).toBe(false);
    expect(__testing.archiveEntryIsSafe("package/./dist/entry.js", "package")).toBe(false);
    expect(__testing.archiveEntryIsSafe("package//dist/entry.js", "package")).toBe(false);
    expect(__testing.archiveEntryIsSafe("/package/dist/entry.js", "package")).toBe(false);
    expect(__testing.archiveEntryIsSafe("package\\..\\escape", "package")).toBe(false);
    expect(__testing.archiveEntryIsSafe("other/dist/entry.js", "package")).toBe(false);
  });

  it("activates the app and signer as one ordered transaction", async () => {
    const events: string[] = [];
    await expect(
      __testing.coordinateHostedReleaseTransaction(transaction(), transactionOperations(events)),
    ).resolves.toMatchObject({ action: "committed" });
    expect(events).toEqual([
      "write:quiescing",
      "quiesce-gateway",
      "activate-app",
      "write:app-active",
      "signer:activateRelease",
      "write:signer-active",
      "signer:authorizeGatewayRelease",
      "verify-gateway",
      "write:gateway-verified",
      "signer:commitRelease",
      "finalize-app",
      "remove-journal",
    ]);
  });

  it("restores the app, then signer, then previous Gateway when target health fails", async () => {
    const events: string[] = [];
    const operations = transactionOperations(events, {
      verifyGateway: async () => {
        events.push("verify-gateway");
        throw new Error("target unhealthy");
      },
    });
    await expect(
      __testing.coordinateHostedReleaseTransaction(transaction(), operations),
    ).rejects.toMatchObject({ code: "HOSTED_UPDATE_ROLLED_BACK" });
    expect(events).toEqual([
      "write:quiescing",
      "quiesce-gateway",
      "activate-app",
      "write:app-active",
      "signer:activateRelease",
      "write:signer-active",
      "signer:authorizeGatewayRelease",
      "verify-gateway",
      "write:rolling-back",
      "quiesce-gateway",
      "signer:gateGatewayRelease",
      "restore-app",
      "signer:rollbackRelease",
      "write:rollback-ready",
      "refresh-previous",
      "remove-journal",
    ]);
  });

  it("never rolls back after the durable health commit decision", async () => {
    const events: string[] = [];
    const operations = transactionOperations(events, {
      signerRequest: async (operation: string) => {
        events.push(`signer:${operation}`);
        if (operation === "commitRelease") {
          throw new Error("response lost");
        }
      },
    });
    await expect(
      __testing.coordinateHostedReleaseTransaction(transaction(), operations),
    ).rejects.toMatchObject({ code: "HOSTED_COMMIT_PENDING" });
    expect(events).toEqual([
      "write:quiescing",
      "quiesce-gateway",
      "activate-app",
      "write:app-active",
      "signer:activateRelease",
      "write:signer-active",
      "signer:authorizeGatewayRelease",
      "verify-gateway",
      "write:gateway-verified",
      "signer:commitRelease",
    ]);
  });

  it("resumes a repair whose signer was preactivated while the Gateway stayed gated", async () => {
    const events: string[] = [];
    await expect(
      __testing.coordinateHostedReleaseTransaction(
        transaction("signer-preactivated"),
        transactionOperations(events),
      ),
    ).resolves.toMatchObject({ action: "committed" });
    expect(events).toEqual([
      "quiesce-gateway",
      "activate-app",
      "write:signer-active",
      "signer:authorizeGatewayRelease",
      "verify-gateway",
      "write:gateway-verified",
      "signer:commitRelease",
      "finalize-app",
      "remove-journal",
    ]);
  });

  it("translates an old root updater rejection into one-time migration guidance", () => {
    expect(
      __testing.hostedUpdaterError(new Error("request contains unsupported fields"), false).message,
    ).toBe(PRE_V2_HOSTING_MIGRATION_MESSAGE);
    expect(
      __testing.hostedUpdaterError(new Error("refusing signer release below rollback floor"), false)
        .message,
    ).toContain("rollback floor");
    expect(
      __testing.hostedUpdaterError(new Error("request contains unsupported fields"), false)
        .hostUpdaterAmbiguous,
    ).toBe(false);
  });

  it("distinguishes a definitive pre-v2 rejection from an ambiguous post-send disconnect", async () => {
    const rejected = await withUnixServer((socket) => {
      socket.once("data", () => {
        socket.end(`${JSON.stringify({ ok: false, error: "unsupported updater schema" })}\n`);
      });
    });
    try {
      await expect(
        __testing.requestHostedSignerTransaction(
          "prepareRelease",
          TRANSACTION_ID,
          "1.2.3",
          1000,
          rejected.socketPath,
        ),
      ).rejects.toMatchObject({ hostUpdaterAmbiguous: false });
    } finally {
      await rejected.close();
    }

    const disconnected = await withUnixServer((socket) => {
      socket.once("data", () => socket.destroy());
    });
    try {
      await expect(
        __testing.requestHostedSignerTransaction(
          "prepareRelease",
          TRANSACTION_ID,
          "1.2.3",
          1000,
          disconnected.socketPath,
        ),
      ).rejects.toMatchObject({ hostUpdaterAmbiguous: true });
    } finally {
      await disconnected.close();
    }
  });

  it("requires app-account protocol-v2 features and valid signer policy hashes", async () => {
    const features = [
      "failClosedPolicies",
      "policyHashes",
      "durableCaps",
      "atomicIdempotency",
      "ambiguousBroadcastReconciliation",
      "signerOwnedKeys",
      "typedSolanaTransactions",
    ];
    const serveHealth = async (featureList: string[]) =>
      await withUnixServer((socket) => {
        socket.once("data", () => {
          socket.end(
            `${JSON.stringify({
              ok: true,
              result: {
                ready: true,
                keystoreType: "signer-owned-v2",
                capabilities: { protocol: { current: 2, min: 2, max: 2 }, features: featureList },
                policies: [
                  {
                    walletId: "agent",
                    version: 1,
                    hash: `sha256:${"a".repeat(64)}`,
                  },
                ],
              },
            })}\n`,
          );
        });
      });
    const healthy = await serveHealth(features);
    try {
      await expect(
        __testing.probeHostedSignerCompatibility(healthy.socketPath, 1000),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await healthy.close();
    }
    const incomplete = await serveHealth(features.slice(1));
    try {
      await expect(
        __testing.probeHostedSignerCompatibility(incomplete.socketPath, 1000),
      ).rejects.toThrow("missing failClosedPolicies");
    } finally {
      await incomplete.close();
    }
  });
});
