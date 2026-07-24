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

  it("packages the root bootstrap and invokes it before Local completion", () => {
    const installer = fs.readFileSync(path.join(process.cwd(), "install.sh"), "utf8");
    const packageMetadata = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { files: string[] };
    expect(packageMetadata.files).toContain("scripts/protected-local-bootstrap.mjs");
    expect(installer).toContain("--protected-local-root-bootstrap");
    expect(installer).toContain("bootstrap_protected_local_topology");
    expect(installer).toContain("--protected-local-gateway-mode");
    expect(installer).toContain("bootstrap_protected_local_topology rollback");
    expect(installer).toContain(
      "Onboarding did not complete; the prior Local signer and Gateway topology was restored.",
    );
    expect(installer).toContain("signer_sha256=");
  });
});
