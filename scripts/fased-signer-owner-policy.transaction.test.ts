import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __testing,
  buildAdminInvocation,
  normalizeOwnerPolicy,
  runInitialSignerPolicySetup,
} from "./fased-signer-owner-policy.mjs";

const roots: string[] = [];
const uid = process.getuid?.() ?? 1000;
const destination = "So11111111111111111111111111111111111111112";

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fsp.chmod(root, 0o700).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  }
});

async function fixtureRoot() {
  const root = await fsp.mkdtemp(path.join(process.cwd(), ".owner-policy-test-"));
  roots.push(root);
  await fsp.chmod(root, 0o700);
  return root;
}

function validPolicy(overrides: Record<string, unknown> = {}) {
  return {
    walletId: "agent",
    role: "agent",
    operations: ["solana.nativeTransfer"],
    programs: [__testing.SYSTEM_PROGRAM],
    assets: [
      {
        asset: "solana:native",
        destinations: [destination],
        maxPerTx: "10000000",
        maxDaily: "50000000",
      },
    ],
    ...overrides,
  };
}

async function writePolicy(root: string, value: unknown, mode = 0o600) {
  const policyPath = path.join(root, "policy.json");
  const raw = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  await fsp.writeFile(policyPath, raw, { mode });
  await fsp.chmod(policyPath, mode);
  return policyPath;
}

function lockedPolicy(walletId = "agent", role = "agent") {
  return __testing.policyWithVersion(
    { walletId, role, operations: [], programs: [], assets: [] },
    1,
  );
}

function jsonBuffer(value: unknown) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function localPlan(root: string) {
  return {
    profile: "local",
    effectiveUID: uid,
    signerUID: uid,
    signerHome: root,
    binaryPath: path.join(root, ".fased", "bin", "fased-signerd"),
    controlSocketPath: path.join(root, ".fased", "wallet", "local-signer-control.sock"),
    executablePath: path.join(root, ".fased", "bin", "fased-signerd"),
    executablePrefix: [],
    childEnv: {
      HOME: root,
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
  };
}

async function successfulFlow(options: {
  nonInteractive?: boolean;
  confirmDigest?: string;
  runCommand?: (invocation: ReturnType<typeof buildAdminInvocation>) => Promise<Buffer>;
  prompt?: (expected: string) => Promise<string>;
}) {
  const root = await fixtureRoot();
  const policy = normalizeOwnerPolicy(validPolicy());
  const policyPath = await writePolicy(root, validPolicy());
  const raw = await fsp.readFile(policyPath);
  const digest = `sha256:${(await import("node:crypto")).createHash("sha256").update(raw).digest("hex")}`;
  const expected = __testing.policyWithVersion(policy, 2);
  const calls: ReturnType<typeof buildAdminInvocation>[] = [];
  let getCount = 0;
  let cleanupCount = 0;
  const chunks: string[] = [];
  const runCommand =
    options.runCommand ??
    (async (invocation: ReturnType<typeof buildAdminInvocation>) => {
      calls.push(invocation);
      const operation = invocation.args[invocation.args.indexOf("policy") + 1];
      if (operation === "get") {
        getCount += 1;
        return jsonBuffer(getCount === 1 ? lockedPolicy() : expected);
      }
      return jsonBuffer(expected);
    });
  const result = await runInitialSignerPolicySetup(
    {
      profile: "local",
      initialInstall: true,
      policyFile: policyPath,
      nonInteractive: options.nonInteractive ?? false,
      confirmDigest: options.confirmDigest ?? (options.nonInteractive ? digest : undefined),
    },
    {
      resolvePlan: async () => localPlan(root),
      runCommand,
      stagePolicy: async () => ({
        path: path.join(root, ".fased", "wallet", ".owner-policy-test", "policy.json"),
        cleanup: async () => {
          cleanupCount += 1;
        },
      }),
      policyFileBoundary: root,
      promptConfirmation:
        options.prompt ??
        (async (confirmation: string) => {
          expect(confirmation).toBe(`agent ${digest}`);
          return confirmation;
        }),
      output: { write: (chunk: string) => chunks.push(chunk) },
    },
  );
  return { calls, chunks, cleanupCount, digest, expected, policyPath, result, root };
}

describe("initial-only policy transaction", () => {
  it("prints every reviewed field, confirms wallet plus exact input digest, and verifies ack/readback", async () => {
    const { chunks, cleanupCount, digest, expected, result } = await successfulFlow({});
    expect(expected.hash).toBe(
      "sha256:519b36d2f7eeb44a20c7ed4a8cf8d01371063cc71246299c4ab052a3b1712f92",
    );
    const output = chunks.join("");
    expect(output).toContain(`Input SHA-256: ${digest}`);
    expect(output).toContain("Wallet: agent");
    expect(output).toContain("Role: agent");
    expect(output).toContain("solana.nativeTransfer");
    expect(output).toContain(__testing.SYSTEM_PROGRAM);
    expect(output).toContain(destination);
    expect(output).toContain("Max per transaction (raw units): 1000000");
    expect(output).toContain("Max per UTC day (raw units): 5000000");
    expect(output.trim().split("\n").at(-1)).toBe(
      JSON.stringify({
        version: 2,
        hash: expected.hash,
        status: "acknowledged",
      }),
    );
    expect(result).toEqual({
      walletId: "agent",
      version: 2,
      hash: expected.hash,
      status: "acknowledged",
    });
    expect(cleanupCount).toBe(1);
  });

  it("requires exact precomputed bytes plus explicit initial-install in noninteractive mode", async () => {
    const root = await fixtureRoot();
    const policyPath = await writePolicy(root, validPolicy());
    const plan = localPlan(root);
    await expect(
      runInitialSignerPolicySetup(
        {
          profile: "local",
          initialInstall: false,
          policyFile: policyPath,
          nonInteractive: true,
          confirmDigest: `sha256:${"a".repeat(64)}`,
        },
        { resolvePlan: async () => plan, policyFileBoundary: root },
      ),
    ).rejects.toThrow("--initial-install");
    await expect(
      runInitialSignerPolicySetup(
        {
          profile: "local",
          initialInstall: true,
          policyFile: policyPath,
          nonInteractive: true,
          confirmDigest: `sha256:${"a".repeat(64)}`,
        },
        { resolvePlan: async () => plan, policyFileBoundary: root },
      ),
    ).rejects.toThrow("does not match the exact policy file bytes");
  });

  it("refuses role mismatch and a current policy that is not version-1 deny-all", async () => {
    const root = await fixtureRoot();
    const policyPath = await writePolicy(root, validPolicy());
    const common = {
      resolvePlan: async () => localPlan(root),
      policyFileBoundary: root,
      output: { write: () => true },
    };
    await expect(
      runInitialSignerPolicySetup(
        { profile: "local", initialInstall: true, policyFile: policyPath },
        {
          ...common,
          runCommand: async () => jsonBuffer(lockedPolicy("agent", "mining")),
        },
      ),
    ).rejects.toThrow("immutable role");

    const initialized = __testing.policyWithVersion(normalizeOwnerPolicy(validPolicy()), 1);
    await expect(
      runInitialSignerPolicySetup(
        { profile: "local", initialInstall: true, policyFile: policyPath },
        { ...common, runCommand: async () => jsonBuffer(initialized) },
      ),
    ).rejects.toThrow("genuinely deny-all");
  });

  it("does not retry a version race and always cleans the signer-owned stage", async () => {
    const root = await fixtureRoot();
    const policy = normalizeOwnerPolicy(validPolicy());
    const policyPath = await writePolicy(root, validPolicy());
    const raced = __testing.policyWithVersion(
      {
        ...policy,
        assets: [{ ...policy.assets[0], maxPerTx: "6500000", maxDaily: "6500000" }],
      },
      2,
    );
    let calls = 0;
    let puts = 0;
    let cleaned = 0;
    await expect(
      runInitialSignerPolicySetup(
        { profile: "local", initialInstall: true, policyFile: policyPath },
        {
          resolvePlan: async () => localPlan(root),
          policyFileBoundary: root,
          runCommand: async (invocation) => {
            calls += 1;
            const operation = invocation.args[invocation.args.indexOf("policy") + 1];
            if (operation === "put") {
              puts += 1;
              throw new Error("signer policy version conflict: expected 1, current 2");
            }
            return jsonBuffer(calls === 1 ? lockedPolicy() : raced);
          },
          stagePolicy: async () => ({
            path: path.join(root, "stage", "policy.json"),
            cleanup: async () => {
              cleaned += 1;
            },
          }),
          promptConfirmation: async (expected) => expected,
          output: { write: () => true },
        },
      ),
    ).rejects.toThrow("version conflict");
    expect(puts).toBe(1);
    expect(cleaned).toBe(1);
  });

  it("rejects a strict signer acknowledgement mismatch after exact durable readback", async () => {
    const root = await fixtureRoot();
    const policy = normalizeOwnerPolicy(validPolicy());
    const policyPath = await writePolicy(root, validPolicy());
    const expected = __testing.policyWithVersion(policy, 2);
    const mismatched = __testing.policyWithVersion(
      {
        ...policy,
        assets: [{ ...policy.assets[0], maxPerTx: "6500000", maxDaily: "6500000" }],
      },
      2,
    );
    let calls = 0;
    await expect(
      runInitialSignerPolicySetup(
        { profile: "local", initialInstall: true, policyFile: policyPath },
        {
          resolvePlan: async () => localPlan(root),
          policyFileBoundary: root,
          runCommand: async (invocation) => {
            calls += 1;
            const operation = invocation.args[invocation.args.indexOf("policy") + 1];
            if (operation === "put") {
              return jsonBuffer(mismatched);
            }
            return jsonBuffer(calls === 1 ? lockedPolicy() : expected);
          },
          stagePolicy: async () => ({
            path: path.join(root, "stage.json"),
            cleanup: async () => {},
          }),
          promptConfirmation: async (confirmation) => confirmation,
          output: { write: () => true },
        },
      ),
    ).rejects.toThrow("acknowledgement content did not match");
  });

  it("reports cleanup failure as an ambiguous mutation and never claims success", async () => {
    const root = await fixtureRoot();
    const policy = normalizeOwnerPolicy(validPolicy());
    const policyPath = await writePolicy(root, validPolicy());
    const expected = __testing.policyWithVersion(policy, 2);
    let calls = 0;
    await expect(
      runInitialSignerPolicySetup(
        { profile: "local", initialInstall: true, policyFile: policyPath },
        {
          resolvePlan: async () => localPlan(root),
          policyFileBoundary: root,
          runCommand: async (invocation) => {
            calls += 1;
            const operation = invocation.args[invocation.args.indexOf("policy") + 1];
            if (operation === "put") {
              return jsonBuffer(expected);
            }
            return jsonBuffer(calls === 1 ? lockedPolicy() : expected);
          },
          stagePolicy: async () => ({
            path: path.join(root, "stage.json"),
            cleanup: async () => {
              throw new Error("disk error");
            },
          }),
          promptConfirmation: async (confirmation) => confirmation,
          output: { write: () => true },
        },
      ),
    ).rejects.toThrow("staging cleanup failed");
  });
});
