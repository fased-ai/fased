import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectWalletSignerDoctorReport } from "./wallet.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("collectWalletSignerDoctorReport", () => {
  it("uses config-merged env when resolving per-chain keystore paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-wallet-doctor-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const configuredKeystore = path.join(root, "configured-solana.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configuredKeystore, '{"kind":"unknown"}', "utf8");

    const report = await collectWalletSignerDoctorReport(
      {
        HOME: "/home/root",
        FASED_STATE_DIR: stateDir,
      } as NodeJS.ProcessEnv,
      {
        config: {
          env: {
            vars: {
              FASED_WALLET_SOLANA_KEYSTORE_PATH: configuredKeystore,
            },
          },
          wallet: {
            provider: { id: "embedded-keystore" },
          },
        },
      },
    );

    expect(
      report.checks.find((check) => check.check === "keystore.file.solana.default")?.detail,
    ).toContain(configuredKeystore);
    expect(
      report.checks.find((check) => check.check === "keystore.file.solana.default")?.detail,
    ).not.toContain("/home/root/.fased/wallet/keystore.v1.enc");
  });

  it("does not require phantom default local-signer wallets when named wallets are configured", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-wallet-doctor-local-signer-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const walletDir = path.join(stateDir, "wallet");
    const solanaKeystore = path.join(walletDir, "keystore-solana-solana-1.v1.enc");
    fs.mkdirSync(walletDir, { recursive: true });
    fs.writeFileSync(
      solanaKeystore,
      JSON.stringify(
        {
          kind: "fased-solana-keypair",
          version: 1,
          kdf: "scrypt",
          cipher: "aes-256-gcm",
          salt: "AA",
          iv: "AA",
          authTag: "AA",
          ciphertext: "AA",
          publicKey: "So11111111111111111111111111111111111111112",
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(path.join(walletDir, "passphrase"), "test-passphrase\n", "utf8");
    fs.writeFileSync(
      path.join(walletDir, "provider-registry.v1.json"),
      JSON.stringify(
        {
          version: 1,
          providers: {
            "embedded-keystore": { enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" },
            "local-socket-signer": { enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" },
            alchemy: { enabled: false, updatedAt: "2026-01-01T00:00:00.000Z" },
            turnkey: { enabled: false, updatedAt: "2026-01-01T00:00:00.000Z" },
            privy: { enabled: false, updatedAt: "2026-01-01T00:00:00.000Z" },
          },
          wallets: [
            {
              id: "solana_1",
              name: "Solana 1",
              providerId: "local-socket-signer",
              addresses: { solana: "So11111111111111111111111111111111111111112" },
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          assignments: {},
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        null,
        2,
      ),
      "utf8",
    );

    const report = await collectWalletSignerDoctorReport(
      {
        HOME: "/home/test",
        FASED_STATE_DIR: stateDir,
      } as NodeJS.ProcessEnv,
      {
        config: {
          env: {
            vars: {
              FASED_WALLET_SOLANA_KEYSTORE_PATH__SOLANA_1: solanaKeystore,
              FASED_WALLET_SOLANA_RPC_URL__SOLANA_1: "https://rpc.example/solana",
            },
          },
          wallet: {
            provider: { id: "local-socket-signer" },
            keystore: {
              enabled: true,
              path: path.join(walletDir, "keystore-solana-solana-4.v1.enc"),
            },
          },
        },
      },
    );

    expect(report.checks.some((check) => check.check === "keystore.file.solana.default")).toBe(
      false,
    );
    expect(report.checks.some((check) => check.check === "keystore.file.solana.default")).toBe(
      false,
    );
    expect(report.checks.find((check) => check.check === "rpc.configured.solana")?.detail).toBe(
      "https://rpc.example/solana",
    );
    expect(
      report.checks.find((check) => check.check === "keystore.file.solana.solana_1")?.detail,
    ).toContain("keystore-solana-solana-1.v1.enc");
    expect(
      report.checks.some((check) => check.check === "keystore.passphrase.solana.solana_1"),
    ).toBe(false);
  });

  it("uses canonical local signer sidecar paths instead of socket-suffixed files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-wallet-doctor-sidecars-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const walletDir = path.join(stateDir, "wallet");
    fs.mkdirSync(walletDir, { recursive: true });

    const report = await collectWalletSignerDoctorReport(
      {
        HOME: "/home/test",
        FASED_STATE_DIR: stateDir,
      } as NodeJS.ProcessEnv,
      {
        config: {
          wallet: {
            provider: { id: "local-socket-signer" },
          },
        },
      },
    );

    expect(report.socketPath).toBe(path.join(walletDir, "local-signer.sock"));
    expect(report.pidPath).toBe(path.join(walletDir, "local-signer.pid"));
    expect(report.auditPath).toBe(path.join(walletDir, "local-signer.audit.jsonl"));
  });

  it("does not surface raw missing sidecar ENOENTs before wallet setup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-wallet-doctor-fresh-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const walletDir = path.join(stateDir, "wallet");
    fs.mkdirSync(walletDir, { recursive: true });

    const report = await collectWalletSignerDoctorReport(
      {
        HOME: "/home/app",
        FASED_STATE_DIR: stateDir,
      } as NodeJS.ProcessEnv,
      {
        config: {
          wallet: {
            provider: { id: "local-socket-signer" },
          },
        },
      },
    );

    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.check === "socket.exists")).toMatchObject({
      ok: true,
      detail: "Configure",
    });
    expect(report.checks.find((check) => check.check === "pid.alive")).toMatchObject({
      ok: true,
      detail: "Configure",
    });
    expect(report.checks.find((check) => check.check === "audit.exists")).toMatchObject({
      ok: true,
      detail: "Configure",
    });
    expect(report.checks.find((check) => check.check === "socket.health")).toMatchObject({
      ok: true,
      detail: "Configure",
    });
    expect(JSON.stringify(report.checks)).not.toContain("ENOENT");
  });
});
