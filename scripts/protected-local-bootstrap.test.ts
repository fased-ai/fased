import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProtectedLocalBootstrapSpec,
  renderProtectedLocalOperatorEnvironment,
  renderProtectedLocalOwnerWrapper,
  __testing,
} from "./protected-local-bootstrap.mjs";
import { buildProtectedLocalLayout } from "./protected-local-layout.mjs";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-protected-local-bootstrap-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("protected Local bootstrap contract", () => {
  it("accepts only one exact release and explicit Gateway phase", () => {
    const root = temporaryRoot();
    const home = path.join(root, "home", "operator");
    const stateDir = path.join(home, ".fased");
    const runtimeDir = path.join(stateDir, "runtime", "releases", "0.1.80");
    fs.mkdirSync(runtimeDir, { recursive: true });
    expect(
      buildProtectedLocalBootstrapSpec({
        operatorUser: "operator",
        operatorUid: 1000,
        operatorGid: 1000,
        operatorHome: home,
        stateDir,
        runtimeDir,
        nodeBinary: "/usr/bin/node",
        releaseVersion: "0.1.80",
        releaseCommit: "a".repeat(40),
        updateChannel: "stable",
        gatewayPort: 18789,
        gatewayMode: "prepare",
        profile: "default",
      }),
    ).toMatchObject({
      releaseVersion: "0.1.80",
      releaseCommit: "a".repeat(40),
      gatewayMode: "prepare",
    });
    expect(() =>
      buildProtectedLocalBootstrapSpec({
        operatorUser: "operator",
        operatorUid: 1000,
        operatorGid: 1000,
        operatorHome: home,
        stateDir,
        runtimeDir,
        nodeBinary: "/usr/bin/node",
        releaseVersion: "0.1.80",
        releaseCommit: "a".repeat(40),
        updateChannel: "stable",
        gatewayPort: 18789,
        gatewayMode: "skip",
      }),
    ).toThrow(/Gateway mode must be prepare, activate, or rollback/u);
    expect(
      buildProtectedLocalBootstrapSpec({
        operatorUser: "operator",
        operatorUid: 1000,
        operatorGid: 1000,
        operatorHome: home,
        stateDir,
        runtimeDir,
        nodeBinary: "/usr/bin/node",
        releaseVersion: "0.1.80",
        releaseCommit: "a".repeat(40),
        updateChannel: "stable",
        gatewayPort: 18789,
        gatewayMode: "rollback",
        profile: "default",
      }),
    ).toMatchObject({ gatewayMode: "rollback" });
  });

  it("binds all operator paths and owner commands to one random instance", () => {
    const layout = buildProtectedLocalLayout("0123456789abcdef");
    const environment = renderProtectedLocalOperatorEnvironment({
      layout,
      stateDir: "/home/operator/.fased",
    });
    expect(environment).toEqual({
      FASED_HOST_PROFILE: "local",
      FASED_PROTECTED_LOCAL: "1",
      FASED_PROTECTED_LOCAL_INSTANCE: "0123456789abcdef",
      FASED_WALLET_LOCAL_SIGNER_LIFECYCLE: "external",
      FASED_WALLET_LOCAL_SIGNER_BIN: "/opt/fased/local/0123456789abcdef/signer/fased-signerd",
      FASED_WALLET_LOCAL_SIGNER_SOCKET: "/run/fased-local/0123456789abcdef/application/app.sock",
      FASED_HOST_UPDATER_SOCKET: "/run/fased-local-controller/0123456789abcdef/request.sock",
      FASED_HOST_UPDATERCTL_STATE:
        "/home/operator/.fased/protected-local-controller-transaction.json",
    });
    const wrapper = renderProtectedLocalOwnerWrapper({
      layout,
      operatorUid: 1000,
      operatorGid: 1000,
      operatorUser: "operator",
    });
    expect(wrapper).toContain("FASED_SIGNER_USER=fssg-0123456789abcdef"); // pragma: allowlist secret
    expect(wrapper).toContain(
      "FASED_SIGNER_CONTROL_SOCKET=/run/fased-local/0123456789abcdef/control/control.sock",
    );
    expect(wrapper).toContain("FASED_SIGNER_OUTPUT_UID=1000");
    expect(wrapper).toContain("FASED_SIGNER_OUTPUT_GID=1000");
    expect(wrapper).toContain("FASED_SIGNER_OUTPUT_USER=operator");
    expect(wrapper).toContain("FASED_SIGNER_OWNER_LOCAL=1");
    expect(wrapper).toContain('exec /opt/fased/local/0123456789abcdef/signer-owner "$@"');
  });

  it("normalizes registry IDs but preserves the registered public identity", () => {
    const root = temporaryRoot();
    const stateDir = path.join(root, ".fased");
    const walletDir = path.join(stateDir, "wallet");
    fs.mkdirSync(walletDir, { recursive: true });
    fs.writeFileSync(
      path.join(walletDir, "provider-registry.v1.json"),
      `${JSON.stringify({
        version: 1,
        wallets: [
          {
            id: "Agent-2",
            providerId: "local-socket-signer",
            addresses: { solana: "1".repeat(32) },
            metadata: { role: "agent" },
          },
          {
            id: "external",
            providerId: "wallet-standard",
            addresses: { solana: "2".repeat(32) },
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    expect(__testing.registeredSignerWallets({ stateDir })).toEqual([
      {
        walletID: "Agent-2",
        signerWalletID: "agent_2",
        publicKey: "1".repeat(32),
        role: "agent",
      },
    ]);
  });

  it("accepts only bounded plugin trees whose links stay inside the plugin root", async () => {
    const root = temporaryRoot();
    const stateDir = path.join(root, ".fased");
    const pluginRoot = path.join(stateDir, "extensions", "openai-runtime");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.js"), "export {};\n");
    fs.symlinkSync("index.js", path.join(pluginRoot, "entry.js"));

    await expect(
      __testing.inspectInstalledPluginTree(pluginRoot, { stateDir }),
    ).resolves.toMatchObject({ canonicalRoot: pluginRoot });

    fs.unlinkSync(path.join(pluginRoot, "entry.js"));
    fs.writeFileSync(path.join(stateDir, "outside.js"), "export {};\n");
    fs.symlinkSync("../../outside.js", path.join(pluginRoot, "entry.js"));
    await expect(__testing.inspectInstalledPluginTree(pluginRoot, { stateDir })).rejects.toThrow(
      /symlink escapes its root/u,
    );
  });

  it("records the exact installed controller generation identity", () => {
    const server = Buffer.from("controller-server");
    const client = Buffer.from("controller-client");
    expect(__testing.buildControllerIdentity("0.1.80", server, client)).toEqual({
      schemaVersion: 1,
      version: "0.1.80",
      serverSha256: crypto.createHash("sha256").update(server).digest("hex"),
      clientSha256: crypto.createHash("sha256").update(client).digest("hex"),
    });
  });

  it("accepts both managed application runtime identities for exact-version health", () => {
    for (const runtimeSource of ["managed-package", "packaged-runtime"]) {
      expect(
        __testing.protectedLocalGatewayHealthMatches(
          { version: "0.1.80", runtimeSource },
          200,
          "0.1.80",
          undefined,
        ),
      ).toBe(true);
    }
    expect(
      __testing.protectedLocalGatewayHealthMatches(
        { version: "0.1.79", runtimeSource: "managed-package" },
        200,
        "0.1.80",
        undefined,
      ),
    ).toBe(false);
    expect(
      __testing.protectedLocalGatewayHealthMatches(
        { version: "0.1.80", runtimeSource: "source-checkout" },
        200,
        "0.1.80",
        undefined,
      ),
    ).toBe(false);
    expect(
      __testing.protectedLocalGatewayHealthMatches(
        { version: "0.1.80", runtimeSource: "managed-package", pid: 4321 },
        200,
        "0.1.80",
        4321,
      ),
    ).toBe(true);
    expect(
      __testing.protectedLocalGatewayHealthMatches(
        { version: "0.1.80", runtimeSource: "managed-package", pid: 4322 },
        200,
        "0.1.80",
        4321,
      ),
    ).toBe(false);
  });

  it("binds rollback health to the exact previous managed release", () => {
    expect(
      __testing.previousLegacyGatewayVersion({
        manifestSnapshot: {
          existed: true,
          content: Buffer.from(JSON.stringify({ runtime: { activeVersion: "0.1.76-rc.7" } })),
        },
      }),
    ).toBe("0.1.76-rc.7");
    expect(() =>
      __testing.previousLegacyGatewayVersion({
        manifestSnapshot: {
          existed: true,
          content: Buffer.from(JSON.stringify({ runtime: { activeVersion: "latest" } })),
        },
      }),
    ).toThrow(/no exact previous release version/u);
  });

  it("parses restrictive extended ACLs without discarding existing principals", () => {
    const original = __testing.parseDirectoryAcl(`
user::rwx
user:2001:rwx #effective:--x
group::---
mask::--x
other::---
default:user::rwx
default:group::---
default:other::---
`);
    expect(original).toEqual({
      entries: [
        "user::rwx",
        "user:2001:rwx",
        "group::---",
        "mask::--x",
        "other::---",
        "default:user::rwx",
        "default:group::---",
        "default:other::---",
      ],
    });
    expect(
      __testing.gatewayAclGrantState(
        original,
        __testing.parseDirectoryAcl(`
other::---
user:2002:--x
mask::--x
group::---
user:2001:rwx #effective:--x
user::rwx
default:user::rwx
default:group::---
default:other::---
`),
        2002,
      ),
    ).toBe("granted");
    expect(__testing.gatewayAclGrantState(original, original, 2002)).toBe("missing");
    expect(() =>
      __testing.gatewayAclGrantState(
        original,
        __testing.parseDirectoryAcl(`
user::rwx
user:2001:rwx
user:2002:--x
group::---
mask::r-x
other::---
default:user::rwx
default:group::---
default:other::---
`),
        2002,
      ),
    ).toThrow(/changed an existing entry/u);
    expect(() =>
      __testing.parseDirectoryAcl("user::rwx\nuser:operator:r-x\ngroup::---\nother::---\n"),
    ).toThrow(/unsupported access ACL/u);
  });

  it("requires an exact restorable legacy user-unit state", () => {
    for (const state of ["enabled", "disabled", "static", "indirect", "masked"]) {
      expect(__testing.isRestorableLegacyGatewayUnitFileState(state)).toBe(true);
    }
    for (const state of [
      "enabled-runtime",
      "linked",
      "linked-runtime",
      "masked-runtime",
      "generated",
      "transient",
      "alias",
      "",
    ]) {
      expect(__testing.isRestorableLegacyGatewayUnitFileState(state)).toBe(false);
    }
  });

  it("recognizes a prior Local user Gateway from managed install metadata", () => {
    const root = temporaryRoot();
    const stateDir = path.join(root, ".fased");
    fs.mkdirSync(stateDir, { recursive: true });
    expect(__testing.legacyInstallReferencesUserGateway({ stateDir })).toBe(false);
    fs.writeFileSync(
      path.join(stateDir, "install.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        profile: "local",
        service: { name: "fased-gateway.service", scope: "user" },
      })}\n`,
    );
    expect(__testing.legacyInstallReferencesUserGateway({ stateDir })).toBe(true);
  });

  it("journals legacy Gateway state before every live fencing mutation", () => {
    const bootstrap = fs.readFileSync(
      path.join(process.cwd(), "scripts", "protected-local-bootstrap.mjs"),
      "utf8",
    );
    const prepared = bootstrap.slice(
      bootstrap.indexOf("async function activatePreparedBootstrapTransaction"),
      bootstrap.indexOf("async function installProtectedLocal"),
    );
    const install = bootstrap.slice(bootstrap.indexOf("async function installProtectedLocal"));
    for (const flow of [prepared, install]) {
      expect(
        flow.indexOf('persistBootstrapTransaction(transaction, "legacy-gateway-captured")'),
      ).toBeGreaterThan(flow.indexOf("captureLegacyGatewayState(spec, layout)"));
      expect(
        flow.indexOf("fenceLegacyGateway(spec, layout, transaction.legacyGatewayState)"),
      ).toBeGreaterThan(
        flow.indexOf('persistBootstrapTransaction(transaction, "legacy-gateway-captured")'),
      );
    }
  });

  it("treats missing legacy signer material as a clean fresh install", async () => {
    const root = temporaryRoot();
    const materialDir = path.join(root, "missing-wallet");
    await expect(
      __testing.removeLegacySignerMaterial({
        materialDir,
        stateDbPath: path.join(materialDir, "state.db"),
        masterKeyPath: path.join(materialDir, "master.key"),
        auditPath: path.join(materialDir, "audit.jsonl"),
        pidPath: path.join(materialDir, "signer.pid"),
        controlSocketPath: path.join(materialDir, "control.sock"),
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts only the exact published signer enrollment hardlink during migration", async () => {
    const root = temporaryRoot();
    const stateDir = path.join(root, ".fased");
    const binDir = path.join(stateDir, "bin");
    const binaryPath = path.join(binDir, "fased-signerd");
    const enrollmentPath = path.join(binDir, "fased-signer-enroll");
    const unexpectedPath = path.join(binDir, "unexpected-hardlink");
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(binaryPath, "verified signer bytes", { mode: 0o700 });
    fs.linkSync(binaryPath, enrollmentPath);
    const identity = fs.statSync(binaryPath);
    const spec = {
      stateDir,
      operatorUid: identity.uid,
      operatorGid: identity.gid,
    };

    const trusted = await __testing.resolveTrustedLegacyRuntimeHardlinks(spec);
    expect(trusted).toEqual(
      new Set([fs.realpathSync(binaryPath), fs.realpathSync(enrollmentPath)]),
    );
    await expect(
      __testing.hardenOperatorRuntime(binDir, spec, new Set(), trusted),
    ).resolves.toBeUndefined();

    fs.linkSync(binaryPath, unexpectedPath);
    await expect(__testing.resolveTrustedLegacyRuntimeHardlinks(spec)).resolves.toEqual(new Set());
    await expect(
      __testing.hardenOperatorRuntime(binDir, spec, new Set(), new Set()),
    ).rejects.toThrow(/unsafe entry/u);
  });

  it("packages the root bootstrap and invokes it before Local completion", () => {
    const installer = fs.readFileSync(path.join(process.cwd(), "install.sh"), "utf8");
    const bootstrap = fs.readFileSync(
      path.join(process.cwd(), "scripts", "protected-local-bootstrap.mjs"),
      "utf8",
    );
    const packageMetadata = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { files: string[] };
    expect(packageMetadata.files).toContain("scripts/protected-local-bootstrap.mjs");
    expect(bootstrap).toContain('"/opt/fased",\n    "/opt/fased/local"');
    expect(installer).toContain("--protected-local-root-bootstrap");
    expect(installer).toContain("bootstrap_protected_local_topology");
    expect(installer).toContain("--protected-local-gateway-mode");
    expect(installer).toContain("--protected-local-gateway-health-timeout-ms");
    expect(installer).toContain("--gateway-health-timeout-ms");
    expect(installer).toContain("bootstrap_protected_local_topology rollback");
    expect(installer).toContain(
      "Onboarding did not complete; the prior Local signer and Gateway topology was restored.",
    );
    expect(installer).toContain("signer_sha256=");
    expect(installer).toContain("apt-get install -y git curl ca-certificates jq acl");
    expect(installer).toContain('missing+=("acl")');
    expect(installer).toContain("pacman -Sy --needed --noconfirm git curl ca-certificates jq acl");
  });

  it("selects a fixed system Node instead of the operator's active version-manager Node", () => {
    const installer = fs.readFileSync(path.join(process.cwd(), "install.sh"), "utf8");
    const resolverStart = installer.indexOf("resolve_protected_local_system_node() {");
    const resolverEnd = installer.indexOf("\n}\n", resolverStart);
    const resolver = installer.slice(resolverStart, resolverEnd);
    const bootstrapStart = installer.indexOf("bootstrap_protected_local_topology() {");
    const bootstrapEnd = installer.indexOf("\n}\n", bootstrapStart);
    const bootstrap = installer.slice(bootstrapStart, bootstrapEnd);

    expect(resolver).toContain("for candidate in /usr/bin/node /usr/local/bin/node");
    expect(resolver).toContain('node_runtime_ok_for "$candidate"');
    expect(resolver).toContain('readlink -f -- "$candidate"');
    expect(resolver).not.toContain("command -v node");
    expect(bootstrap).toContain("resolve_protected_local_system_node");
    expect(bootstrap).not.toContain('readlink -f "$(command -v node)"');
    expect(bootstrap).toContain('PATH="/usr/sbin:/usr/bin:/sbin:/bin"');
    expect(bootstrap).toContain("install_linux_system_dependencies 0");
  });

  it("restores the managed runtime when protected bootstrap preflight fails", () => {
    const installer = fs.readFileSync(path.join(process.cwd(), "install.sh"), "utf8");
    const bootstrapCall = installer.lastIndexOf(
      'if ! bootstrap_protected_local_topology "$protected_gateway_mode"',
    );
    const failureEnd = installer.indexOf("\n  fi", bootstrapCall);
    const failureBranch = installer.slice(bootstrapCall, failureEnd);

    expect(failureBranch).toContain("rollback_managed_runtime_after_failed_install");
    expect(failureBranch).toContain("the prior Local runtime and service topology were restored");
    expect(failureBranch).toContain("automatic Local runtime rollback was incomplete");
  });
});
