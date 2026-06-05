import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";

const mocks = vi.hoisted(() => ({
  randomToken: vi.fn(),
}));

vi.mock("../commands/onboard-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("../commands/onboard-helpers.js")>();
  return {
    ...actual,
    randomToken: mocks.randomToken,
  };
});

vi.mock("../infra/tailscale.js", () => ({
  findTailscaleBinary: vi.fn(async () => undefined),
}));

import { configureGatewayForOnboarding } from "./onboarding.gateway-config.js";

describe("configureGatewayForOnboarding", () => {
  function createPrompter(params: { selectQueue: string[]; textQueue: Array<string | undefined> }) {
    const selectQueue = [...params.selectQueue];
    const textQueue = [...params.textQueue];

    return {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select: vi.fn(async <T>() => selectQueue.shift() as T) as WizardPrompter["select"],
      multiselect: vi.fn(async <T>() => [] as T[]) as WizardPrompter["multiselect"],
      text: vi.fn(async () => textQueue.shift() as string),
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    } satisfies WizardPrompter;
  }

  function createRuntime(): RuntimeEnv {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
  }

  it("generates a token when the prompt returns undefined", async () => {
    mocks.randomToken.mockReturnValue("generated-token");

    const prompter = createPrompter({
      selectQueue: ["loopback", "token", "off"],
      textQueue: [undefined],
    });
    const runtime = createRuntime();

    const result = await configureGatewayForOnboarding({
      flow: "advanced",
      hostProfile: "local",
      baseConfig: {},
      nextConfig: {},
      localPort: 18789,
      quickstartGateway: {
        hasExisting: false,
        port: 18789,
        bind: "loopback",
        authMode: "token",
        tailscaleMode: "off",
        token: undefined,
        password: undefined,
        customBindHost: undefined,
        tailscaleResetOnExit: false,
        federationEnabled: false,
      },
      prompter,
      runtime,
    });

    expect(result.settings.gatewayToken).toBe("generated-token");
    expect(result.nextConfig.gateway?.nodes?.denyCommands).toEqual([
      "camera.snap",
      "camera.clip",
      "screen.record",
      "calendar.add",
      "contacts.add",
      "reminders.add",
    ]);
  });

  it("keeps the current gateway token when update prompt is blank", async () => {
    mocks.randomToken.mockReturnValue("should-not-be-used");

    const prompter = createPrompter({
      selectQueue: ["loopback", "token", "off"],
      textQueue: [""],
    });
    const runtime = createRuntime();

    const result = await configureGatewayForOnboarding({
      flow: "quickstart",
      hostProfile: "local",
      baseConfig: {},
      nextConfig: {},
      localPort: 18789,
      quickstartGateway: {
        hasExisting: true,
        port: 18789,
        bind: "loopback",
        authMode: "token",
        tailscaleMode: "off",
        token: "existing-token",
        password: undefined,
        customBindHost: undefined,
        tailscaleResetOnExit: false,
        federationEnabled: false,
      },
      prompter,
      runtime,
    });

    expect(result.settings.gatewayToken).toBe("existing-token");
    expect(result.nextConfig.gateway?.auth).toEqual({
      mode: "token",
      token: "existing-token",
    });
    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Gateway token (blank to keep current)",
      }),
    );
  });

  it("does not set password to literal 'undefined' when prompt returns undefined", async () => {
    mocks.randomToken.mockReturnValue("unused");

    // Flow: loopback bind → password auth → tailscale off
    const prompter = createPrompter({
      selectQueue: ["loopback", "password", "off"],
      textQueue: [undefined],
    });
    const runtime = createRuntime();

    const result = await configureGatewayForOnboarding({
      flow: "advanced",
      hostProfile: "local",
      baseConfig: {},
      nextConfig: {},
      localPort: 18789,
      quickstartGateway: {
        hasExisting: false,
        port: 18789,
        bind: "loopback",
        authMode: "password",
        tailscaleMode: "off",
        token: undefined,
        password: undefined,
        customBindHost: undefined,
        tailscaleResetOnExit: false,
        federationEnabled: false,
      },
      prompter,
      runtime,
    });

    const authConfig = result.nextConfig.gateway?.auth as { mode?: string; password?: string };
    expect(authConfig?.mode).toBe("password");
    expect(authConfig?.password).toBe("");
    expect(authConfig?.password).not.toBe("undefined");
  });

  it("keeps hosting Tailscale setup in the later host-security stage", async () => {
    mocks.randomToken.mockReturnValue("strict-token");

    const prompter = createPrompter({
      selectQueue: [],
      textQueue: [],
    });
    const runtime = createRuntime();

    const result = await configureGatewayForOnboarding({
      flow: "quickstart",
      hostProfile: "hosting",
      baseConfig: {},
      nextConfig: {},
      localPort: 18789,
      quickstartGateway: {
        hasExisting: false,
        port: 18789,
        bind: "loopback",
        authMode: "token",
        tailscaleMode: "serve",
        token: undefined,
        password: undefined,
        customBindHost: undefined,
        tailscaleResetOnExit: false,
        federationEnabled: false,
      },
      prompter,
      runtime,
    });

    expect(result.settings.bind).toBe("loopback");
    expect(result.settings.tailscaleMode).toBe("serve");
    expect(result.settings.gatewayToken).toBe("strict-token");
    expect(result.nextConfig.gateway?.trustedProxies).toEqual(["127.0.0.1/32", "::1/128"]);
    expect(prompter.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Tailscale binary not found"),
      "Tailscale Warning",
    );
    expect(prompter.note).not.toHaveBeenCalledWith(
      "Tailscale requires bind=loopback. Adjusting bind to loopback.",
      "Note",
    );
  });

  it("treats local profile as loopback without hosting tailscale requirements", async () => {
    mocks.randomToken.mockReturnValue("local-token");

    const prompter = createPrompter({
      selectQueue: ["loopback", "token", "off"],
      textQueue: [],
    });
    const runtime = createRuntime();

    const result = await configureGatewayForOnboarding({
      flow: "quickstart",
      hostProfile: "local",
      baseConfig: {},
      nextConfig: {},
      localPort: 18789,
      quickstartGateway: {
        hasExisting: false,
        port: 18789,
        bind: "loopback",
        authMode: "token",
        tailscaleMode: "off",
        token: undefined,
        password: undefined,
        customBindHost: undefined,
        tailscaleResetOnExit: false,
        federationEnabled: false,
      },
      prompter,
      runtime,
    });

    expect(result.settings.bind).toBe("loopback");
    expect(result.settings.tailscaleMode).toBe("off");
    expect(result.settings.gatewayToken).toBe("local-token");
    expect(prompter.select).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Tailscale exposure",
      }),
    );
    expect(prompter.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Tailscale binary not found"),
      "Tailscale Warning",
    );
  });

  it("limits onboarding bind choices to loopback, lan, and custom", async () => {
    mocks.randomToken.mockReturnValue("generated-token");

    const prompter = createPrompter({
      selectQueue: ["loopback", "token", "off"],
      textQueue: ["18789", undefined],
    });
    const runtime = createRuntime();

    await configureGatewayForOnboarding({
      flow: "advanced",
      hostProfile: "local",
      baseConfig: {},
      nextConfig: {},
      localPort: 18789,
      quickstartGateway: {
        hasExisting: false,
        port: 18789,
        bind: "tailnet",
        authMode: "token",
        tailscaleMode: "off",
        token: undefined,
        password: undefined,
        customBindHost: undefined,
        tailscaleResetOnExit: false,
        federationEnabled: false,
      },
      prompter,
      runtime,
    });

    expect(prompter.select).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: "Gateway bind",
        initialValue: "loopback",
        options: [
          expect.objectContaining({ value: "loopback" }),
          expect.objectContaining({ value: "lan" }),
          expect.objectContaining({ value: "custom" }),
        ],
      }),
    );
  });
});
