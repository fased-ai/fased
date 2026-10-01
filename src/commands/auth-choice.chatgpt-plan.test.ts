import { afterEach, expect, it, vi } from "vitest";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";
const mocks = vi.hoisted(() => ({ login: vi.fn(), discover: vi.fn(), runtime: vi.fn() }));
vi.mock("./openai-codex-oauth.js", () => ({ loginOpenAICodexOAuth: mocks.login }));
vi.mock("../agents/openai-codex-runtime-component.js", () => ({
  ensureOpenAICodexRuntimeComponent: mocks.runtime,
}));
vi.mock("./openai-codex-model-default.js", async (original) => ({
  ...(await original<typeof import("./openai-codex-model-default.js")>()),
  discoverOpenAICodexDefaultModel: mocks.discover,
}));
import { applyAuthChoiceOpenAI } from "./auth-choice.apply.openai.js";
const lifecycle = createAuthTestLifecycle([
  "FASED_STATE_DIR",
  "FASED_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
]);
afterEach(async () => {
  vi.clearAllMocks();
  await lifecycle.cleanup();
});
it("joins sign-in, account pinning and discovered model selection without acquiring legacy Codex", async () => {
  const env = await setupAuthTestEnv("fased-plan-joined-test-");
  lifecycle.setStateDir(env.stateDir);
  const credential = {
    chatgptPlan: true,
    clientId: "oaiapp_test",
    subject: "owner",
    hostId: "test-host",
    idToken: "test-id",
    email: "owner@example.com",
    scopes: ["chatgpt.tokens.use.direct"],
    access: "test-access",
    refresh: "test-refresh",
    expires: Date.now() + 3600000,
  };
  mocks.login.mockResolvedValue(credential);
  mocks.discover.mockResolvedValue("openai-codex/account-model");
  const params = {
    authChoice: "openai-codex" as const,
    config: {},
    prompter: createWizardPrompter({}, { defaultSelect: "plaintext" }),
    runtime: createExitThrowingRuntime(),
    agentDir: env.agentDir,
    setDefaultModel: true,
    oauthBrowserMode: "local" as const,
  };
  const result = await applyAuthChoiceOpenAI(params);
  expect(mocks.runtime).not.toHaveBeenCalled();
  const saved = await readAuthProfilesForAgent<{
    profiles: Record<string, unknown>;
    order: Record<string, string[]>;
  }>(env.agentDir);
  const profileId = Object.keys(saved.profiles)[0];
  expect(saved.profiles[profileId]).toMatchObject(credential);
  expect(saved.order["openai-codex"]).toEqual([profileId]);
  expect(result?.config.auth?.order?.["openai-codex"]).toEqual([profileId]);
  expect(result?.config.agents?.defaults?.model).toMatchObject({
    primary: "openai-codex/account-model",
  });
  const select = vi.fn(async () => profileId);
  await applyAuthChoiceOpenAI({
    ...params,
    config: result!.config,
    prompter: createWizardPrompter({ select }),
  });
  expect(mocks.login.mock.lastCall?.[0].existing).toMatchObject(credential);
});
