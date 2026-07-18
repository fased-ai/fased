import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __testing, assertHostingUpdateGateInactive } from "./fased-signer-owner-policy.mjs";

const roots: string[] = [];
const uid = process.getuid?.() ?? 1000;

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fsp.chmod(root, 0o700).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  }
});

async function fixtureRoot() {
  const root = await fsp.mkdtemp(path.join(process.cwd(), ".owner-policy-cli-test-"));
  roots.push(root);
  await fsp.chmod(root, 0o700);
  return root;
}

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
