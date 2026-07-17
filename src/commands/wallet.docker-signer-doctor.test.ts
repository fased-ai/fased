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

describe("Docker signer doctor", () => {
  it("uses socket health instead of container-inaccessible PID and audit files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-wallet-doctor-docker-"));
    tempDirs.push(root);

    const report = await collectWalletSignerDoctorReport(
      {
        HOME: root,
        FASED_STATE_DIR: path.join(root, "state"),
        FASED_WALLET_LOCAL_SIGNER_LIFECYCLE: "external",
        FASED_WALLET_LOCAL_SIGNER_SOCKET: "/run/fased-signerd/app.sock",
        FASED_WALLET_SIGNER_STATE_DIR: "/var/lib/fased-signerd",
      } as NodeJS.ProcessEnv,
      {
        config: {
          wallet: {
            provider: { id: "local-socket-signer" },
          },
        },
      },
    );

    expect(report.checks.find((check) => check.check === "pid.alive")).toMatchObject({
      ok: true,
      detail: "lifecycle=external; process health is verified over the socket",
    });
    expect(report.checks.find((check) => check.check === "audit.exists")).toMatchObject({
      ok: true,
      detail: "lifecycle=external; audit state is signer-owned",
    });
    expect(JSON.stringify(report.checks)).not.toContain("/var/lib/fased-signerd/audit");
  });
});
