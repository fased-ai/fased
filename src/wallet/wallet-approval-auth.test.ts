import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeWalletApprovalGrant,
  readWalletApprovalAuthSnapshot,
  removeWalletPasskey,
} from "./wallet-approval-auth.js";

const tempDirs: string[] = [];

function createAuthEnv(mode: "none" | "webauthn" = "webauthn") {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-wallet-auth-"));
  tempDirs.push(stateDir);
  const walletDir = path.join(stateDir, "wallet");
  fs.mkdirSync(walletDir, { recursive: true });
  const env = {
    FASED_STATE_DIR: stateDir,
    FASED_WALLET_APPROVAL_AUTH: mode,
  } as NodeJS.ProcessEnv;
  return { env, walletDir };
}

describe("wallet approval auth", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows removing the last passkey so the operator can enroll a new one", () => {
    const { env, walletDir } = createAuthEnv();
    fs.writeFileSync(
      path.join(walletDir, "wallet-approval-auth.json"),
      `${JSON.stringify(
        {
          version: 2,
          passkeys: [
            {
              id: "credential-1",
              label: "fc",
              createdAt: "2026-04-08T12:30:08.000Z",
              publicKeySpki: "pub",
              publicKeyAlgorithm: -7,
              signCount: 0,
            },
          ],
          challenges: [],
          grants: [],
        },
        null,
        2,
      )}\n`,
    );

    const removed = removeWalletPasskey({ credentialId: "credential-1", env });

    expect(removed).toMatchObject({ ok: true });
    expect(readWalletApprovalAuthSnapshot(env)).toMatchObject({
      mode: "webauthn",
      ready: false,
      passkeyCount: 0,
    });
  });

  it("does not require approval grants when passkey mode is off", () => {
    const { env } = createAuthEnv("none");

    expect(
      consumeWalletApprovalGrant({
        host: "127.0.0.1",
        operation: "wallet.send",
        token: "",
        env,
      }),
    ).toMatchObject({ ok: true });
  });

  it("blocks approval grants when passkey mode is on but no passkey is enrolled", () => {
    const { env } = createAuthEnv("webauthn");

    expect(
      consumeWalletApprovalGrant({
        host: "127.0.0.1",
        operation: "wallet.send",
        token: "",
        env,
      }),
    ).toMatchObject({
      ok: false,
      code: "wallet_control_passkey_not_ready",
    });
  });

  it("requires an approval token when passkey mode is on and a passkey is enrolled", () => {
    const { env, walletDir } = createAuthEnv("webauthn");
    fs.writeFileSync(
      path.join(walletDir, "wallet-approval-auth.json"),
      `${JSON.stringify(
        {
          version: 2,
          passkeys: [
            {
              id: "credential-1",
              label: "fc",
              createdAt: "2026-04-08T12:30:08.000Z",
              publicKeySpki: "pub",
              publicKeyAlgorithm: -7,
              signCount: 0,
            },
          ],
          challenges: [],
          grants: [],
        },
        null,
        2,
      )}\n`,
    );

    expect(
      consumeWalletApprovalGrant({
        host: "127.0.0.1",
        operation: "wallet.send",
        token: "",
        env,
      }),
    ).toMatchObject({
      ok: false,
      code: "approval_token_required",
    });
  });
});
