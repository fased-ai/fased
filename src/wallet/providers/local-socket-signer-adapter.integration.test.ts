import { execFile, spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT } from "../../mining/sat-vnext-release-contract.generated.js";
import { invokeNativeSignerOperatorCapabilities } from "../native-signer-operator-client.js";
import { SIGNER_PROTOCOL_V2 } from "../signer-protocol-v2.generated.js";
import {
  callLocalSocketSigner,
  requireLocalSocketSignerProtocolV2,
} from "./local-socket-signer-adapter.js";

const execFileAsync = promisify(execFile);
const cleanupDirs: string[] = [];
const children = new Set<ChildProcess>();

async function waitForSocket(socketPath: string, child: ChildProcess, stderr: () => string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`fased-signerd exited before readiness: ${stderr()}`);
    }
    try {
      if ((await lstat(socketPath)).isSocket()) {
        return;
      }
    } catch {
      // The signer creates its state before binding the socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fased-signerd did not create its socket: ${stderr()}`);
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
  children.clear();
  while (cleanupDirs.length > 0) {
    await rm(cleanupDirs.pop()!, { recursive: true, force: true });
  }
});

describe("compiled fased-signerd protocol-v2 compatibility", () => {
  it("advertises the generated contract accepted by the TypeScript adapter", async () => {
    if (process.platform === "win32") {
      return;
    }
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "fased-signerd-contract-"));
    cleanupDirs.push(tempDir);
    const binary = path.join(tempDir, "fased-signerd");
    await execFileAsync("go", ["build", "-buildvcs=false", "-o", binary, "."], {
      cwd: path.join(process.cwd(), "tools", "fased-signerd"),
      env: {
        ...process.env,
        GOCACHE: path.join(tempDir, "go-cache"),
        GOMODCACHE: process.env.GOMODCACHE || path.join(os.tmpdir(), "fased-go-mod-cache"),
      },
      timeout: 120_000,
    });

    const socketPath = path.join(tempDir, "application.sock");
    const operatorSocketPath = path.join(tempDir, "operator.sock");
    const operatorGroup = (await execFileAsync("id", ["-gn"])).stdout.trim();
    let stderr = "";
    const child = spawn(
      binary,
      [
        "--socket",
        socketPath,
        "--control-socket",
        path.join(tempDir, "control.sock"),
        "--operator-socket",
        operatorSocketPath,
        "--operator-socket-group",
        operatorGroup,
        "--state-db",
        path.join(tempDir, "state.db"),
        "--master-key",
        path.join(tempDir, "master.key"),
        "--pid-file",
        path.join(tempDir, "signer.pid"),
        "--audit-log",
        path.join(tempDir, "audit.jsonl"),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    children.add(child);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    await waitForSocket(socketPath, child, () => stderr);
    await waitForSocket(operatorSocketPath, child, () => stderr);

    await expect(
      requireLocalSocketSignerProtocolV2(socketPath, "solana.jupiter.swap"),
    ).resolves.toBeUndefined();
    const result = await callLocalSocketSigner<{
      ready: boolean;
      capabilities: typeof SIGNER_PROTOCOL_V2;
      satRelease: typeof SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT;
    }>(socketPath, { op: "v2.capabilities" });
    expect(result.ready).toBe(true);
    expect(result.capabilities).toEqual(SIGNER_PROTOCOL_V2);
    expect(result.satRelease).toEqual(SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT);

    await callLocalSocketSigner(socketPath, {
      op: "v2.wallet.create",
      walletId: "mining",
      request: {
        expectedPolicyVersion: 0,
        policy: {
          role: "mining",
          operations: [],
          programs: [],
          assets: [],
        },
      },
    });
    const allocationFp = Array.from({ length: 16 }, () => 62_500);
    const commitmentRequest = {
      cluster: "devnet" as const,
      programId: "H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF", // pragma: allowlist secret
      protocolGeneration: SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.interfaceContractSha256,
      cycleId: "5959753",
      committedLamports: "1000000000",
      allocationFp,
    };
    const commitment = await callLocalSocketSigner<{
      reference: string;
      commitmentHex: string;
      cycleId: string;
      committedLamports: string;
      allocationCount: number;
      protocolGeneration: string;
    }>(socketPath, {
      op: "v2.satCommitment.allocate",
      walletId: "mining",
      request: commitmentRequest,
    });
    expect(commitment).toMatchObject({
      cycleId: commitmentRequest.cycleId,
      committedLamports: commitmentRequest.committedLamports,
      allocationCount: allocationFp.length,
      protocolGeneration: commitmentRequest.protocolGeneration,
    });
    expect(commitment.reference).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(commitment.commitmentHex).toMatch(/^[0-9a-f]{64}$/u);

    const binding = await callLocalSocketSigner<typeof commitment>(socketPath, {
      op: "v2.satCommitment.binding.get",
      walletId: "mining",
      request: {
        cluster: commitmentRequest.cluster,
        programId: commitmentRequest.programId,
        protocolGeneration: commitmentRequest.protocolGeneration,
        cycleId: commitmentRequest.cycleId,
      },
    });
    expect(binding).toEqual(commitment);

    const operatorResult = invokeNativeSignerOperatorCapabilities({
      signerBinPath: binary,
      operatorSocketPath,
      env: { HOME: tempDir },
    });
    expect(operatorResult.ready).toBe(true);
    expect(operatorResult.capabilities.protocol).toEqual(SIGNER_PROTOCOL_V2.protocol);
    expect(operatorResult.capabilities.features).toEqual(SIGNER_PROTOCOL_V2.features);
  }, 150_000);
});
