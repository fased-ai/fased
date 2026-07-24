import { describe, expect, it } from "vitest";
import { protectedLocalControllerConfiguration, __testing } from "./fased-host-updater.mjs";

describe("Protected Local root controller configuration", () => {
  it("derives every privileged path and service from one random instance identity", () => {
    const instanceId = "0123456789abcdef";
    expect(protectedLocalControllerConfiguration(instanceId)).toEqual({
      profile: "protected-local",
      instanceId,
      signerServiceName: `fased-signerd-${instanceId}.service`,
      gatewayServiceName: `fased-gateway-${instanceId}.service`,
      signerApplicationSocketPath: `/run/fased-local/${instanceId}/application/app.sock`,
      paths: {
        socketPath: `/run/fased-local-controller/${instanceId}/request.sock`,
        stateDir: `/var/lib/fased-local/${instanceId}/controller`,
        controllerReleasesDir: `/opt/fased/local/${instanceId}/controller/releases`,
        controllerCurrentLink: `/opt/fased/local/${instanceId}/controller/current`,
        controllerVersionPath: `/var/lib/fased-local/${instanceId}/controller/controller-version.json`,
        signerPath: `/opt/fased/local/${instanceId}/signer/fased-signerd`,
        signerStateDBPath: `/var/lib/fased-local/${instanceId}/signer/state.db`,
        signerUnitPath: `/etc/systemd/system/fased-signerd-${instanceId}.service`,
        versionPath: `/var/lib/fased-local/${instanceId}/controller/signer-version`,
        channelPath: `/etc/fased/local/${instanceId}/update-channel`,
        journalPath: `/var/lib/fased-local/${instanceId}/controller/active-signer-transaction.json`,
        rollbackFloorPath: `/var/lib/fased-local/${instanceId}/controller/rollback-floor`,
        gatewayGatePath: `/var/lib/fased-local/${instanceId}/controller/gateway-update-gate`,
        signerGatePath: `/var/lib/fased-local/${instanceId}/controller/signer-update-gate`,
        transactionsDir: `/var/lib/fased-local/${instanceId}/controller/transactions`,
      },
    });
  });

  it("rejects caller-controlled profile text and malformed instance identities", () => {
    for (const value of ["", "agent", "../agent", "0123456789ABCDEf", "0".repeat(15)]) {
      expect(() => protectedLocalControllerConfiguration(value)).toThrow(
        /instance ID must be 16 lowercase hex/i,
      );
    }
  });

  it("binds the protected controller socket directly to the exact operator UID", () => {
    expect(
      __testing.parseServerConfiguration([
        "--protected-local-instance",
        "0123456789abcdef",
        "--socket-uid",
        "1000",
        "--socket-gid",
        "1000",
      ]),
    ).toMatchObject({
      profile: "protected-local",
      instanceId: "0123456789abcdef",
      socketUid: 1000,
      socketGid: 1000,
    });
    expect(() =>
      __testing.parseServerConfiguration([
        "--protected-local-instance",
        "0123456789abcdef",
        "--socket-gid",
        "1000",
      ]),
    ).toThrow(/requires its exact operator user id/u);
  });
});
