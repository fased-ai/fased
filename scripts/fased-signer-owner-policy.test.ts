import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __testing,
  assertHostingUpdateGateInactive,
  buildAdminInvocation,
  createExecutionPlan,
  normalizeOwnerPolicy,
  readOwnerPolicyFile,
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
        maxPerTx: "1000000",
        maxDaily: "5000000",
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

describe("strict owner policy input", () => {
  it("normalizes a typed policy deterministically and preserves the federation signer domain", () => {
    const federation = normalizeOwnerPolicy({
      walletId: "vault",
      role: "vault",
      operations: ["federation.bondChallenge"],
      programs: [__testing.FEDERATION_POLICY_DOMAIN],
      assets: [
        {
          asset: "federation:bond-challenge",
          destinations: [destination],
          maxPerTx: "1",
          maxDaily: "1",
        },
      ],
    });
    expect(federation.programs).toEqual([__testing.FEDERATION_POLICY_DOMAIN]);
    expect(federation.assets[0]?.asset).toBe("federation:bond-challenge");

    const unsorted = validPolicy({
      operations: ["solana.splTransferChecked", "solana.nativeTransfer"],
      programs: [
        __testing.TOKEN_PROGRAM,
        __testing.ASSOCIATED_TOKEN_PROGRAM,
        __testing.SYSTEM_PROGRAM,
      ],
      assets: [
        {
          asset: `solana:spl:${destination}`,
          destinations: [__testing.SYSTEM_PROGRAM, destination],
          maxPerTx: "2",
          maxDaily: "3",
        },
        {
          asset: "solana:native",
          destinations: [destination],
          maxPerTx: "1",
          maxDaily: "2",
        },
      ],
    });
    const normalized = normalizeOwnerPolicy(unsorted);
    expect(normalized.operations).toEqual(["solana.nativeTransfer", "solana.splTransferChecked"]);
    expect(normalized.assets.map((asset) => asset.asset)).toEqual([
      "solana:native",
      `solana:spl:${destination}`,
    ]);
  });

  it("rejects unknown and duplicate JSON fields before native signer execution", async () => {
    const root = await fixtureRoot();
    const unknownPath = await writePolicy(root, { ...validPolicy(), extra: true });
    await expect(readOwnerPolicyFile(unknownPath, uid, root)).rejects.toThrow("unknown: extra");

    const duplicateRoot = await fixtureRoot();
    const duplicate = JSON.stringify(validPolicy()).replace(
      '"walletId":"agent"',
      '"walletId":"agent","walletId":"agent"',
    );
    const duplicatePath = await writePolicy(duplicateRoot, duplicate);
    await expect(readOwnerPolicyFile(duplicatePath, uid, duplicateRoot)).rejects.toThrow(
      "duplicate JSON field",
    );
  });

  it.each([
    [
      "duplicate operations",
      validPolicy({ operations: ["solana.nativeTransfer", "solana.nativeTransfer"] }),
      "duplicate",
    ],
    ["invalid role", validPolicy({ role: "reserve" }), "policy role"],
    ["invalid program", validPolicy({ programs: ["not-a-public-key"] }), "Solana public key"],
    [
      "noncanonical cap",
      validPolicy({
        assets: [
          {
            asset: "solana:native",
            destinations: [destination],
            maxPerTx: "01",
            maxDaily: "2",
          },
        ],
      }),
      "canonical positive",
    ],
    [
      "zero cap",
      validPolicy({
        assets: [
          {
            asset: "solana:native",
            destinations: [destination],
            maxPerTx: "0",
            maxDaily: "2",
          },
        ],
      }),
      "canonical positive",
    ],
    [
      "inverted caps",
      validPolicy({
        assets: [
          {
            asset: "solana:native",
            destinations: [destination],
            maxPerTx: "3",
            maxDaily: "2",
          },
        ],
      }),
      "at least maxPerTx",
    ],
  ])("rejects malicious policy semantics: %s", (_name, policy, message) => {
    expect(() => normalizeOwnerPolicy(policy)).toThrow(String(message));
  });

  it("rejects symlinks, unsafe permissions, unsafe parents, wrong ownership, and oversized data", async () => {
    const symlinkRoot = await fixtureRoot();
    const source = path.join(symlinkRoot, "source.json");
    await fsp.writeFile(source, JSON.stringify(validPolicy()), { mode: 0o600 });
    const symlink = path.join(symlinkRoot, "policy.json");
    await fsp.symlink(source, symlink);
    await expect(readOwnerPolicyFile(symlink, uid, symlinkRoot)).rejects.toThrow("non-symlink");

    const modeRoot = await fixtureRoot();
    const modePath = await writePolicy(modeRoot, validPolicy(), 0o640);
    await expect(readOwnerPolicyFile(modePath, uid, modeRoot)).rejects.toThrow("inaccessible");

    const parentRoot = await fixtureRoot();
    const parentPath = await writePolicy(parentRoot, validPolicy());
    await fsp.chmod(parentRoot, 0o777);
    await expect(readOwnerPolicyFile(parentPath, uid, parentRoot)).rejects.toThrow(
      "group/world writable",
    );

    const ownerRoot = await fixtureRoot();
    const ownerPath = await writePolicy(ownerRoot, validPolicy());
    await expect(
      readOwnerPolicyFile(ownerPath, uid + 1, ownerRoot, new Set([0, uid])),
    ).rejects.toThrow("wrong owner");

    const largeRoot = await fixtureRoot();
    const largePath = path.join(largeRoot, "policy.json");
    await fsp.writeFile(largePath, Buffer.alloc(64 * 1024 + 1, 0x20), { mode: 0o600 });
    await expect(readOwnerPolicyFile(largePath, uid, largeRoot)).rejects.toThrow("1 to 65536");
  });
});

describe("Local and Hosting execution identity", () => {
  it("uses only the same-user Local native signer and a sanitized environment", () => {
    const plan = createExecutionPlan("local", {
      effectiveUID: 1234,
      home: "/home/alice",
    });
    const invocation = buildAdminInvocation(plan, "put", "agent", "/home/alice/staged/policy.json");
    expect(invocation.command).toBe("/home/alice/.fased/bin/fased-signerd");
    expect(invocation.args).toEqual([
      "admin",
      "policy",
      "put",
      "--control-socket",
      "/home/alice/.fased/wallet/local-signer-control.sock",
      "--wallet-id",
      "agent",
      "--expected-version",
      "1",
      "--policy-file",
      "/home/alice/staged/policy.json",
    ]);
    expect(invocation.args).not.toContain("sudo");
    expect(Object.keys(invocation.env).toSorted()).toEqual([
      "HOME",
      "LANG",
      "LC_ALL",
      "NO_COLOR",
      "PATH",
    ]);
    expect(() => createExecutionPlan("local", { effectiveUID: 0, home: "/root" })).toThrow(
      "must not run as root",
    );
  });

  it("uses fixed runuser, signer binary, socket, account, and minimal environment for Hosting", () => {
    const plan = createExecutionPlan("hosting", {
      effectiveUID: 0,
      platform: "linux",
      signerUID: 992,
    });
    const invocation = buildAdminInvocation(
      plan,
      "put",
      "vault",
      "/run/fased-signerd/.owner-policy-random/policy.json",
    );
    expect(invocation.command).toBe("/usr/sbin/runuser");
    expect(invocation.args.slice(0, 5)).toEqual([
      "-u",
      "fased-signer",
      "--",
      "/opt/fased/signer/fased-signerd",
      "admin",
    ]);
    expect(invocation.args).toContain("/run/fased-signerd/control.sock");
    expect(invocation.env.HOME).toBe("/var/lib/fased-signerd");
    expect(Object.keys(invocation.env).toSorted()).toEqual([
      "HOME",
      "LANG",
      "LC_ALL",
      "NO_COLOR",
      "PATH",
    ]);
    expect(() =>
      createExecutionPlan("hosting", { effectiveUID: 1000, platform: "linux", signerUID: 992 }),
    ).toThrow("must run as root");
    expect(() =>
      createExecutionPlan("hosting", { effectiveUID: 0, platform: "darwin", signerUID: 992 }),
    ).toThrow("only on Linux");
    expect(() =>
      createExecutionPlan("hosting", { effectiveUID: 0, platform: "linux", signerUID: 0 }),
    ).toThrow("dedicated non-root");
  });

  it("never places policy JSON, destinations, caps, or ambient Fased variables in argv/env", async () => {
    const { calls } = await successfulFlow({ nonInteractive: true });
    for (const invocation of calls) {
      const argv = invocation.args.join(" ");
      const environment = JSON.stringify(invocation.env);
      expect(argv).not.toContain(destination);
      expect(argv).not.toContain("1000000");
      expect(argv).not.toContain("solana.nativeTransfer");
      expect(argv).not.toContain("{");
      expect(environment).not.toContain("FASED_");
      expect(environment).not.toContain(destination);
    }
  });

  it("stages exact bytes in an exclusive same-user directory and durably removes it", async () => {
    const root = await fixtureRoot();
    const parent = path.join(root, ".fased", "wallet");
    await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
    const raw = Buffer.from(`${JSON.stringify(validPolicy())}\n`);
    const staged = await __testing.stagePolicyFile(localPlan(root), raw);
    const stagedDirectory = path.dirname(staged.path);
    expect(await fsp.readFile(staged.path)).toEqual(raw);
    expect((await fsp.stat(staged.path)).mode & 0o777).toBe(0o600);
    expect((await fsp.stat(stagedDirectory)).mode & 0o777).toBe(0o700);
    expect((await fsp.stat(staged.path)).uid).toBe(uid);
    await staged.cleanup();
    await expect(fsp.access(staged.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.access(stagedDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("root signer update gate", () => {
  it("accepts only absence in a trusted directory and refuses active or malformed gates", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "gate");
    const gatePath = path.join(directory, "active");
    await expect(
      assertHostingUpdateGateInactive(
        { updateGateDirectory: directory, updateGatePath: gatePath },
        uid,
      ),
    ).rejects.toThrow("missing or unreadable");
    await fsp.mkdir(directory, { mode: 0o700 });
    const paths = { updateGateDirectory: directory, updateGatePath: gatePath };
    await expect(assertHostingUpdateGateInactive(paths, uid)).resolves.toBeUndefined();

    await fsp.writeFile(gatePath, "active\n", { mode: 0o600 });
    await expect(assertHostingUpdateGateInactive(paths, uid)).rejects.toThrow("is active");

    await fsp.rm(gatePath);
    await fsp.symlink(path.join(root, "missing"), gatePath);
    await expect(assertHostingUpdateGateInactive(paths, uid)).rejects.toThrow(
      "present but invalid",
    );

    await fsp.rm(gatePath);
    await fsp.chmod(directory, 0o777);
    await expect(assertHostingUpdateGateInactive(paths, uid)).rejects.toThrow(
      "directory is invalid",
    );
  });
});

describe("CLI safety", () => {
  it("rejects duplicate/unknown flags and intentionally has no permissive --yes", () => {
    expect(() => __testing.parseCLI(["--profile", "local", "--profile", "hosting"])).toThrow(
      "duplicate argument",
    );
    expect(() => __testing.parseCLI(["--policy-json", "{}"])).toThrow("unknown argument");
    expect(() => __testing.parseCLI(["--yes"])).toThrow("unknown argument");
    expect(() => __testing.parseCLI(["--help", "--yes"])).toThrow("must be used alone");
    expect(
      __testing.parseCLI(["--profile", "local", "--initial-install", "--policy-file", "/x"]),
    ).toEqual({
      profile: "local",
      policyFile: "/x",
      confirmDigest: undefined,
      initialInstall: true,
      nonInteractive: false,
    });
  });
});
