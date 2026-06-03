import type { FasedAgentConfig, RuntimeEnv } from "fased/plugin-sdk";
import { describe, expect, it } from "vitest";
import { msteamsPlugin } from "./channel.js";

describe("msteams directory", () => {
  const runtimeEnv: RuntimeEnv = {
    log: () => {},
    error: () => {},
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  it("attaches onboarding setup to the channel plugin", () => {
    expect(msteamsPlugin.onboarding?.channel).toBe("msteams");
    expect(msteamsPlugin.onboarding?.uiSetup).toMatchObject({
      title: "Microsoft Teams",
      fields: expect.arrayContaining([
        expect.objectContaining({ label: "App ID" }),
        expect.objectContaining({ label: "App Password" }),
        expect.objectContaining({ label: "Tenant ID" }),
      ]),
      access: expect.objectContaining({ kind: "msteams-channels" }),
    });
  });

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        msteams: {
          allowFrom: ["alice", "user:Bob"],
          dms: { carol: {}, bob: {} },
          teams: {
            team1: {
              channels: {
                "conversation:chan1": {},
                chan2: {},
              },
            },
          },
        },
      },
    } as unknown as FasedAgentConfig;

    expect(msteamsPlugin.directory).toBeTruthy();
    expect(msteamsPlugin.directory?.listPeers).toBeTruthy();
    expect(msteamsPlugin.directory?.listGroups).toBeTruthy();

    await expect(
      msteamsPlugin.directory!.listPeers!({
        cfg,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "user:alice" },
        { kind: "user", id: "user:Bob" },
        { kind: "user", id: "user:carol" },
        { kind: "user", id: "user:bob" },
      ]),
    );

    await expect(
      msteamsPlugin.directory!.listGroups!({
        cfg,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "group", id: "conversation:chan1" },
        { kind: "group", id: "conversation:chan2" },
      ]),
    );
  });
});
