import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";
const recovery = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  create: vi.fn(),
  campaignCreate: vi.fn(),
  refreshAdmittedClaim: vi.fn(async () => ({ signingEnabled: false, items: [] })),
  refreshReviewPage: vi.fn(async () => ({ signingEnabled: false, items: [] })),
}));
vi.mock("fased/plugin-sdk/sat-runtime", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLocalWenRecoveryProfile: recovery.create,
  createLocalWenCampaignProfile: recovery.campaignCreate,
}));
it("attaches only explicit local profile and drains on checkpoint/stop", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wen-plugin-"));
  let service!: {
    start(context: unknown): Promise<void>;
    stop(context: unknown): Promise<void>;
    checkpointForLifecycle(context: unknown): Promise<void>;
  };
  recovery.create.mockResolvedValue(recovery);
  try {
    vi.stubEnv("FASED_WEN_LOCAL_RECOVERY_PROFILE", "/local/candidate.json");
    plugin.register({
      registerTool: vi.fn(),
      pluginConfig: undefined,
      registerGatewayMethod() {},
      registerService(value: typeof service) {
        service = value;
      },
      logger: { info() {}, warn() {} },
    } as never);
    const context = { stateDir: dir };
    await service.start(context);
    expect(recovery.create).toHaveBeenCalledWith("/local/candidate.json", expect.any(Function));
    expect(recovery.start).toHaveBeenCalledTimes(1);
    await service.checkpointForLifecycle(context);
    expect(recovery.stop).toHaveBeenCalledTimes(1);
    await service.stop(context);
    expect(recovery.stop).toHaveBeenCalledTimes(1);
    vi.stubEnv("FASED_WEN_LOCAL_RECOVERY_PROFILE", "");
    await service.start(context);
    expect(recovery.start).toHaveBeenCalledTimes(1);
    await service.stop(context);
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["wen.mining.review.refresh", "wen.mining.claim.refresh"])(
  "routes explicit unsigned refresh and rejects stopped or overridden requests: %s",
  async (method) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wen-gateway-"));
    let service!: { start(c: unknown): Promise<void>; stop(c: unknown): Promise<void> };
    let handler!: (c: unknown) => Promise<void>;
    const respond = vi.fn();
    recovery.create.mockResolvedValue(recovery);
    const refresh =
      method === "wen.mining.review.refresh"
        ? recovery.refreshReviewPage
        : recovery.refreshAdmittedClaim;
    refresh.mockClear();
    const validParams =
      method === "wen.mining.review.refresh"
        ? { cursor: "admission.json" }
        : { base: {}, reviewSha256: "a".repeat(64) };
    try {
      vi.stubEnv("FASED_WEN_LOCAL_RECOVERY_PROFILE", "/local/candidate.json");
      plugin.register({
        registerTool: vi.fn(),
        registerGatewayMethod(name: string, fn: typeof handler, opts: unknown) {
          if (name === method) {
            handler = fn;
            expect(opts).toEqual({ scope: "operator.admin" });
          }
        },
        registerService(value: typeof service) {
          service = value;
        },
        logger: { info() {}, warn() {} },
      } as never);
      await handler({ params: validParams, respond });
      expect(respond.mock.calls.at(-1)?.[0]).toBe(false);
      await service.start({ stateDir: dir });
      await handler({ params: { walletId: "override" }, respond });
      expect(refresh).not.toHaveBeenCalled();
      await handler({ params: validParams, respond });
      expect(refresh).toHaveBeenCalledWith(
        method === "wen.mining.review.refresh" ? "admission.json" : validParams,
      );
      expect(respond.mock.calls.at(-1)).toEqual([
        true,
        {
          ok: true,
          mode: "local-candidate-only",
          signingEnabled: false,
          payload: { signingEnabled: false, items: [] },
        },
      ]);
      let finish!: (value: { signingEnabled: boolean; items: never[] }) => void;
      refresh.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = handler({ params: validParams, respond });
      await handler({ params: validParams, respond });
      expect(respond.mock.calls.at(-1)?.[0]).toBe(false);
      await service.stop({ stateDir: dir });
      finish({ signingEnabled: false, items: [] });
      await pending;
      expect(respond.mock.calls.at(-1)?.[0]).toBe(false);
      await handler({ params: validParams, respond });
      expect(respond.mock.calls.at(-1)?.[0]).toBe(false);
      recovery.start.mockRejectedValueOnce(Error("profile startup failed"));
      await expect(service.start({ stateDir: dir })).rejects.toThrow("profile startup failed");
      refresh.mockClear();
      await handler({ params: validParams, respond });
      expect(respond.mock.calls.at(-1)?.[0]).toBe(false);
      expect(refresh).not.toHaveBeenCalled();
      await service.stop({ stateDir: dir });
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("loads campaign independently and disables its gateway on checkpoint and invalid startup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wen-campaign-lifecycle-"));
  let service!: {
    start(c: unknown): Promise<void>;
    stop(c: unknown): Promise<void>;
    checkpointForLifecycle(c: unknown): Promise<void>;
  };
  let handler!: (c: unknown) => Promise<void>;
  const profile = {
    stop: vi.fn(),
    cancelClaimApproval: vi.fn(),
    prepareClaimApproval: vi.fn(async () => ({ prepared: true })),
  };
  const respond = vi.fn();
  recovery.campaignCreate.mockResolvedValue(profile);
  try {
    vi.stubEnv("FASED_WEN_LOCAL_RECOVERY_PROFILE", "");
    vi.stubEnv("FASED_WEN_LOCAL_CAMPAIGN_PROFILE", "/local/campaign.json");
    plugin.register({
      registerTool: vi.fn(),
      registerGatewayMethod(name: string, fn: typeof handler) {
        if (name === "wen.campaign.approval.prepare") {
          handler = fn;
        }
      },
      registerService(s: typeof service) {
        service = s;
      },
      logger: { info() {}, warn() {} },
    } as never);
    const call = () => handler({ params: { input: {} }, client: { connId: "owner" }, respond });
    await call();
    expect(respond.mock.calls.at(-1)?.[0]).toBe(false);
    await service.start({ stateDir: dir });
    expect(recovery.campaignCreate).toHaveBeenCalledWith("/local/campaign.json");
    await call();
    expect(respond.mock.calls.at(-1)?.[0]).toBe(true);
    await service.checkpointForLifecycle({ stateDir: dir });
    expect(profile.stop).toHaveBeenCalledTimes(1);
    await call();
    expect(respond.mock.calls.at(-1)?.[0]).toBe(false);
    recovery.campaignCreate.mockRejectedValueOnce(Error("invalid campaign"));
    await expect(service.start({ stateDir: dir })).rejects.toThrow("invalid campaign");
    await call();
    expect(respond.mock.calls.at(-1)?.[0]).toBe(false);
    await service.stop({ stateDir: dir });
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});
