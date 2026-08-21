import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertManagedComponentPackBudget,
  assertManagedRuntimeExternalImportsResolvable,
  normalizedManagedPluginTreeDigest,
  resolveManagedRuntimeImplementationPaths,
  selectedComponentDirectoriesFromArgv,
  shouldExternalizeManagedRuntimeImport,
} from "./build-hosted-component-packs.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed component pack identity", () => {
  it("does not treat the runtime executable as a component selection when the flag is absent", () => {
    expect(
      selectedComponentDirectoriesFromArgv([
        "/opt/fased/node/bin/node",
        "/opt/fased/scripts/build-hosted-component-packs.ts",
        "--output",
        "/tmp/fased-components",
      ]),
    ).toBeUndefined();
    expect([
      ...(selectedComponentDirectoriesFromArgv([
        "/opt/fased/node/bin/node",
        "/opt/fased/scripts/build-hosted-component-packs.ts",
        "--output",
        "/tmp/fased-components",
        "--components",
        "runtime-media, runtime-speech",
      ]) ?? []),
    ]).toEqual(["runtime-media", "runtime-speech"]);
  });

  it("bundles implementation-only runtime entrypoints and removes source entrypoints", async () => {
    const source = await fs.readFile(
      path.join(import.meta.dirname, "build-hosted-component-packs.ts"),
      "utf8",
    );
    expect(source).toContain('import { rolldown } from "rolldown"');
    expect(source).toContain("const bundle = await createManagedRuntimeBundle");
    expect(source).not.toContain("bundledManagedRuntimeComponents");
    expect(source).toContain('entryFileNames: "index.mjs"');
    expect(source).toContain('extensions: ["./index.mjs"]');
    expect(source).toContain('fs.rm(path.join(params.deployRoot, "index.ts"), { force: true })');
    expect(source).not.toContain('"--no-optional"');
    expect(source).toContain('"--config.node-linker=hoisted"');
    expect(source).not.toContain('node_modules", ".bin", "esbuild"');
    const runtimeBrowser = await fs.readFile(
      path.join(import.meta.dirname, "..", "extensions", "runtime-browser", "index.ts"),
      "utf8",
    );
    expect(runtimeBrowser).toContain('id: "browser-runtime-control"');
    expect(runtimeBrowser).toContain("api.registerService");
    const runtimeSpeech = await fs.readFile(
      path.join(import.meta.dirname, "..", "extensions", "runtime-speech", "index.ts"),
      "utf8",
    );
    const runtimeMedia = await fs.readFile(
      path.join(import.meta.dirname, "..", "extensions", "runtime-media", "index.ts"),
      "utf8",
    );
    expect(runtimeMedia).toContain('kind: "media"');
    expect(runtimeMedia).toContain("api.registerRuntimeProvider");
    expect(runtimeSpeech).toContain('kind: "speech"');
    expect(runtimeSpeech).toContain("api.registerRuntimeProvider");
    expect(runtimeSpeech).toContain("api.registerTool");
    const coreTools = await fs.readFile(
      path.join(import.meta.dirname, "..", "src", "agents", "fased-tools.ts"),
      "utf8",
    );
    expect(coreTools).not.toContain("createTtsTool");
    const browserClient = await fs.readFile(
      path.join(import.meta.dirname, "..", "src", "browser", "client-fetch.ts"),
      "utf8",
    );
    expect(browserClient).not.toContain('from "./control-service.js"');
    expect(browserClient).not.toContain('from "./routes/dispatcher.js"');
    const gatewayStartup = await fs.readFile(
      path.join(import.meta.dirname, "..", "src", "gateway", "server-startup.ts"),
      "utf8",
    );
    expect(gatewayStartup).not.toContain("server-browser.js");
  });

  it("binds normalized immutable extraction modes and exact file bytes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-component-identity-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "demo"));
    await fs.writeFile(path.join(root, "demo", "index.js"), "export default {};\n", {
      mode: 0o644,
    });
    const first = await normalizedManagedPluginTreeDigest(root);
    await fs.chmod(path.join(root, "demo", "index.js"), 0o444);
    await expect(normalizedManagedPluginTreeDigest(root)).resolves.toBe(first);
    await fs.chmod(path.join(root, "demo", "index.js"), 0o644);
    await fs.writeFile(path.join(root, "demo", "index.js"), "export default { id: 'demo' };\n");
    await expect(normalizedManagedPluginTreeDigest(root)).resolves.not.toBe(first);
  });

  it("derives exact browser implementation paths while retaining shared core facades", async () => {
    const paths = await resolveManagedRuntimeImplementationPaths(["runtime-browser"]);
    expect(paths).toContain("dist/browser/control-service.js");
    expect(paths).toContain("dist/browser/routes/dispatcher.js");
    expect(paths).not.toContain("dist/browser/config.js");
    expect(paths).not.toContain("dist/browser/profiles.js");
    expect(paths).not.toContain("dist/browser/control-auth.js");
    expect(paths).not.toContain("dist/browser/paths.js");
    expect(paths).toContain("dist/browser/proxy-files.js");
    expect(paths).not.toContain("dist/tts/tts.js");
    expect(paths).not.toContain("dist/infra/home-dir.js");
    expect(paths).not.toContain("dist/plugins/discovery.js");
    expect(paths).not.toContain("dist/web/qr-image.js");
  });

  it("retains Discord target parsing while packing live directory resolution", async () => {
    const paths = await resolveManagedRuntimeImplementationPaths(["discord"]);
    expect(paths).not.toContain("dist/discord/targets.js");
    expect(paths).toContain("dist/discord/targets-live.js");
    expect(paths).toContain("dist/discord/directory-live.js");
    expect(paths).toContain("dist/discord/api.js");
  });

  it("derives LINE implementation paths while retaining shared core facades", async () => {
    const paths = await resolveManagedRuntimeImplementationPaths(["line"]);
    expect(paths).toContain("dist/line/send.js");
    expect(paths).toContain("dist/line/monitor.js");
    expect(paths).not.toContain("dist/config/config.js");
    expect(paths).not.toContain("dist/auto-reply/chunk.js");
    expect(paths).not.toContain("dist/text/strip-markdown.js");
    expect(paths).not.toContain("dist/line/flex-templates.js");
    const coreRuntime = await fs.readFile(
      path.join(process.cwd(), "src", "plugins", "runtime", "index.ts"),
      "utf8",
    );
    expect(coreRuntime).not.toContain('from "../../line/send.js"');
    const componentRuntime = await fs.readFile(
      path.join(process.cwd(), "extensions", "line", "src", "runtime.ts"),
      "utf8",
    );
    expect(componentRuntime).toContain('from "../../../src/line/send.js"');
    const ttsRuntime = await fs.readFile(path.join(process.cwd(), "src", "tts", "tts.ts"), "utf8");
    expect(ttsRuntime).not.toContain("line/markdown-to-line");
    expect(ttsRuntime).toContain('from "../text/strip-markdown.js"');
    const buildConfig = await fs.readFile(path.join(process.cwd(), "tsdown.config.ts"), "utf8");
    expect(buildConfig).toContain('"text/strip-markdown": "src/text/strip-markdown.ts"');
    const launcher = await fs.readFile(path.join(process.cwd(), "fased.mjs"), "utf8");
    expect(launcher).toContain('arg === "--version" || arg === "-V"');
    expect(launcher).toContain('await import("./package.json", { with: { type: "json" } })');
    expect(launcher).toContain("err.url === new URL(specifier, import.meta.url).href");
    const pluginSdk = await fs.readFile(
      path.join(process.cwd(), "src", "plugin-sdk", "index.ts"),
      "utf8",
    );
    expect(pluginSdk).toContain('export { stripMarkdown } from "../text/strip-markdown.js"');
    expect(pluginSdk).not.toContain('from "../line/markdown-to-line.js"');
    expect(pluginSdk).not.toContain('from "../line/accounts.js"');
    const commandRegistry = await fs.readFile(
      path.join(process.cwd(), "src", "cli", "program", "command-registry.ts"),
      "utf8",
    );
    expect(commandRegistry).not.toContain(
      'import { registerWalletCommands } from "./register.wallet.js"',
    );
    expect(commandRegistry).toContain('await import("./register.wallet.js")');
    const fasedTools = await fs.readFile(
      path.join(process.cwd(), "src", "agents", "fased-tools.ts"),
      "utf8",
    );
    expect(fasedTools).not.toContain('from "./tools/browser-tool.js"');
    const browserRuntime = await fs.readFile(
      path.join(process.cwd(), "extensions", "runtime-browser", "index.ts"),
      "utf8",
    );
    expect(browserRuntime).toContain("api.registerTool(createBrowserTool(), { optional: true })");
    const gatewayServer = await fs.readFile(
      path.join(process.cwd(), "src", "gateway", "server.impl.ts"),
      "utf8",
    );
    expect(gatewayServer).toContain('import("../infra/heartbeat-runner.js")');
    expect(gatewayServer).not.toContain(
      'import { startHeartbeatRunner, type HeartbeatRunner } from "../infra/heartbeat-runner.js"',
    );
    expect(gatewayServer).toContain('import("../wizard/onboarding.js")');
    expect(gatewayServer).not.toContain('from "../wizard/onboarding.js"');
    const gatewayCron = await fs.readFile(
      path.join(process.cwd(), "src", "gateway", "server-cron.ts"),
      "utf8",
    );
    expect(gatewayCron).toContain('import("../infra/heartbeat-runner.js")');
    expect(gatewayCron).not.toContain('from "../infra/heartbeat-runner.js"');
    const healthCommand = await fs.readFile(
      path.join(process.cwd(), "src", "commands", "health.ts"),
      "utf8",
    );
    expect(healthCommand).toContain('from "../infra/heartbeat-summary.js"');
    const statusSummary = await fs.readFile(
      path.join(process.cwd(), "src", "commands", "status.summary.ts"),
      "utf8",
    );
    expect(statusSummary).toContain('from "../infra/heartbeat-summary.js"');
    const systemMethods = await fs.readFile(
      path.join(process.cwd(), "src", "gateway", "server-methods", "system.ts"),
      "utf8",
    );
    expect(systemMethods).toContain('import("../../infra/heartbeat-runner.js")');
    expect(systemMethods).not.toContain('from "../../infra/heartbeat-runner.js"');
    const gatewayHealth = await fs.readFile(
      path.join(process.cwd(), "src", "gateway", "server-methods", "health.ts"),
      "utf8",
    );
    expect(gatewayHealth).toContain('from "../../commands/status.summary.js"');
    const embeddedErrors = await fs.readFile(
      path.join(process.cwd(), "src", "agents", "pi-embedded-helpers", "errors.ts"),
      "utf8",
    );
    expect(embeddedErrors).toContain('from "../sandbox/runtime-status.js"');
    const sandboxContext = await fs.readFile(
      path.join(process.cwd(), "src", "agents", "sandbox", "context.ts"),
      "utf8",
    );
    expect(sandboxContext).toContain('import("./browser.js")');
    expect(sandboxContext).not.toContain('from "./browser.js"');
    const sandboxPrune = await fs.readFile(
      path.join(process.cwd(), "src", "agents", "sandbox", "prune.ts"),
      "utf8",
    );
    const sandboxManage = await fs.readFile(
      path.join(process.cwd(), "src", "agents", "sandbox", "manage.ts"),
      "utf8",
    );
    const sandboxBrowser = await fs.readFile(
      path.join(process.cwd(), "src", "agents", "sandbox", "browser.ts"),
      "utf8",
    );
    expect(sandboxPrune).toContain('await import("../../browser/bridge-server.js")');
    expect(sandboxPrune).not.toContain('from "../../browser/bridge-server.js"');
    expect(sandboxManage).toContain('await import("../../browser/bridge-server.js")');
    expect(sandboxManage).not.toContain('from "../../browser/bridge-server.js"');
    expect(sandboxBrowser).toContain('await import("../../browser/bridge-server.js")');
    expect(sandboxBrowser).not.toContain('from "../../browser/bridge-server.js"');
    const compactRunner = await fs.readFile(
      path.join(process.cwd(), "src", "agents", "pi-embedded-runner", "compact.ts"),
      "utf8",
    );
    expect(compactRunner).toContain('from "../sandbox/context.js"');
    const attemptRunner = await fs.readFile(
      path.join(process.cwd(), "src", "agents", "pi-embedded-runner", "run", "attempt.ts"),
      "utf8",
    );
    expect(attemptRunner).toContain('from "../../sandbox/context.js"');
    const autoReplyStatus = await fs.readFile(
      path.join(process.cwd(), "src", "auto-reply", "status.ts"),
      "utf8",
    );
    expect(autoReplyStatus).toContain('from "../agents/sandbox/runtime-status.js"');
    for (const replyFile of [
      "get-reply-directives.ts",
      "bash-command.ts",
      "directive-handling.impl.ts",
      "commands-system-prompt.ts",
      "agent-runner-memory.ts",
      "stage-sandbox-media.ts",
    ]) {
      const replySource = await fs.readFile(
        path.join(process.cwd(), "src", "auto-reply", "reply", replyFile),
        "utf8",
      );
      expect(replySource).not.toContain('from "../../agents/sandbox.js"');
    }
    const pluginLoader = await fs.readFile(
      path.join(process.cwd(), "src", "plugins", "loader.ts"),
      "utf8",
    );
    expect(pluginLoader).toContain('from "./runtime/factory.js"');
    expect(pluginLoader).not.toContain('from "./runtime/index.js"');
    const pluginDoctorCli = await fs.readFile(
      path.join(process.cwd(), "src", "cli", "plugins-doctor-cli.ts"),
      "utf8",
    );
    expect(pluginDoctorCli).toContain("plugins: report.plugins");
    expect(pluginDoctorCli).toContain("opts.json");
    expect(pluginDoctorCli).toContain("logger:");
    const artifactBuilder = await fs.readFile(
      path.join(process.cwd(), "scripts", "build-hosted-runtime-artifact.ts"),
      "utf8",
    );
    expect(artifactBuilder).toContain('FASED_MANAGED_INTERNAL: "1"');
    expect(artifactBuilder).toContain("writeBundledPluginLock(packageRoot)");
    expect(artifactBuilder).not.toContain('type: "fased-plugin-lock", entries: []');
    expect(artifactBuilder).toContain("allow: componentContract.core.loadedPluginIds");
    expect(artifactBuilder).not.toContain("Hosted sat-mining plugin did not load");
    expect(artifactBuilder).toContain("FASED_PLUGIN_LOCK_PATH: smokePluginLockPath");
    expect(artifactBuilder).toContain("FASED_PLUGIN_DATA_ROOT: smokePluginDataRoot");
    for (const miningRpcFile of ["rpc-read.ts", "rpc-read-service.ts"]) {
      const miningRpcSource = await fs.readFile(
        path.join(process.cwd(), "extensions", "sat-mining", "src", miningRpcFile),
        "utf8",
      );
      expect(miningRpcSource).not.toContain('from "fased/plugin-sdk"');
      expect(miningRpcSource).toContain('from "fased/plugin-sdk/sat-runtime"');
    }
  });

  it("derives speech implementation paths for exclusion from the base artifact", async () => {
    const paths = await resolveManagedRuntimeImplementationPaths(["runtime-speech"]);
    expect(paths).toContain("dist/tts/tts.js");
    expect(paths).toContain("dist/tts/tts-core.js");
    expect(paths).not.toContain("dist/plugin-sdk/speech-runtime.js");
  });

  it("derives media implementation paths for exclusion from the base artifact", async () => {
    const paths = await resolveManagedRuntimeImplementationPaths(["runtime-media"]);
    expect(paths).toContain("dist/web/media.js");
    expect(paths).toContain("dist/media/fetch.js");
    expect(paths).toContain("dist/media/store.js");
    expect(paths).toContain("dist/media/audio.js");
    expect(paths).toContain("dist/media/image-ops.js");
    expect(paths).not.toContain("dist/media/runtime-service.js");
    expect(paths).not.toContain("dist/plugins/runtime-provider-runtime.js");
    expect(paths).not.toContain("dist/infra/home-dir.js");
    expect(paths).not.toContain("dist/media/mime.js");
    expect(paths).not.toContain("dist/media/read-response-with-limit.js");
    expect(paths).not.toContain("dist/media/image-ops-contract.js");
  });

  it("moves the ACP protocol bridge and SDK ownership into the acpx component", async () => {
    const paths = await resolveManagedRuntimeImplementationPaths(["acpx"]);
    expect(paths).toContain("dist/cli/acp-cli.js");
    expect(paths).toContain("dist/acp/client.js");
    expect(paths).toContain("dist/acp/server.js");
    expect(paths).toContain("dist/acp/translator.js");
    expect(paths).not.toContain("dist/acp/control-plane/manager.js");

    const rootPackage = JSON.parse(
      await fs.readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const acpxPackage = JSON.parse(
      await fs.readFile(path.join(process.cwd(), "extensions", "acpx", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(rootPackage.dependencies).not.toHaveProperty("@agentclientprotocol/sdk");
    expect(rootPackage.devDependencies).toHaveProperty("@agentclientprotocol/sdk", "0.14.1");
    expect(acpxPackage.dependencies).toHaveProperty("@agentclientprotocol/sdk", "0.14.1");

    const coreSubcommands = await fs.readFile(
      path.join(process.cwd(), "src", "cli", "program", "register.subclis.ts"),
      "utf8",
    );
    expect(coreSubcommands).not.toContain('name: "acp"');
    const acpxEntrypoint = await fs.readFile(
      path.join(process.cwd(), "extensions", "acpx", "index.ts"),
      "utf8",
    );
    expect(acpxEntrypoint).toContain('commands: ["acp"]');
  });

  it("binds channel-specific runtime implementations into their managed archives", async () => {
    const expectations = new Map([
      ["discord", "dist/discord/send.js"],
      ["slack", "dist/slack/send.js"],
      ["telegram", "dist/telegram/send.js"],
      ["signal", "dist/signal/send.js"],
      ["imessage", "dist/imessage/send.js"],
      ["whatsapp", "dist/web/outbound.js"],
    ]);
    for (const [extension, expectedPath] of expectations) {
      const paths = await resolveManagedRuntimeImplementationPaths([extension]);
      expect(paths, extension).toContain(expectedPath);
    }
    const coreRuntime = await fs.readFile(
      path.join(process.cwd(), "src", "plugins", "runtime", "index.ts"),
      "utf8",
    );
    expect(coreRuntime).not.toContain('import("../../discord/send.js")');
    expect(coreRuntime).not.toContain('import("../../slack/send.js")');
    expect(coreRuntime).not.toContain('import("../../telegram/send.js")');
    expect(coreRuntime).not.toContain('from "../../signal/send.js"');
    expect(coreRuntime).not.toContain('from "../../imessage/send.js"');
    expect(coreRuntime).not.toContain('import("../../web/outbound.js")');
  });

  it("keeps the CLI process alive until the selected command completes", async () => {
    const entry = await fs.readFile(path.join(process.cwd(), "src", "entry.ts"), "utf8");
    const runMain = await fs.readFile(
      path.join(process.cwd(), "src", "cli", "run-main.ts"),
      "utf8",
    );
    const runtimeFactory = await fs.readFile(
      path.join(process.cwd(), "src", "plugins", "runtime", "factory.ts"),
      "utf8",
    );

    expect(entry).toContain('void import("./cli/run-main.js")');
    expect(entry).toContain(".then(({ runCli }) => runCli(process.argv))");
    expect(entry).toContain("const cliCompletionKeepAlive = setInterval");
    expect(entry).toContain(".finally(() => clearInterval(cliCompletionKeepAlive));");
    expect(entry).not.toContain('await import("./cli/run-main.js")');
    expect(runMain).toContain("await initializePluginRuntimeFactory();");
    expect(runtimeFactory).toContain('await import("./index.js")');
    expect(runtimeFactory).not.toContain("const runtimeFactory = useManagedFreshCoreRuntime()");
    expect(runtimeFactory).not.toContain('? (await import("./core.js"))');
  });

  it("rejects symbolic-link aliases before producing a managed identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-component-alias-"));
    roots.push(root);
    await fs.writeFile(path.join(root, "source.js"), "export default {};\n");
    await fs.symlink(path.join(root, "source.js"), path.join(root, "alias.js"));
    await expect(normalizedManagedPluginTreeDigest(root)).rejects.toThrow(
      "managed component contains a symbolic link",
    );
  });

  it("rejects any component pack that exceeds the exact P6 transaction limits", () => {
    expect(() =>
      assertManagedComponentPackBudget({
        packId: "diagnostics",
        budgets: {
          maximumArchiveBytes: 10,
          maximumExpandedBytes: 20,
          maximumTarStreamBytes: 30,
          maximumEntries: 40,
        },
        usage: { archiveBytes: 10, expandedBytes: 20, tarStreamBytes: 30, entries: 41 },
      }),
    ).toThrow("component pack diagnostics exceeds P6 transaction budgets");
  });

  it("rejects a bundled component whose external runtime import is not deployed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-component-imports-"));
    roots.push(root);
    const entryPath = path.join(root, "index.mjs");
    await fs.writeFile(entryPath, "export default {};\n");
    await fs.mkdir(path.join(root, "node_modules", "declared-runtime"), { recursive: true });
    await fs.writeFile(
      path.join(root, "node_modules", "declared-runtime", "package.json"),
      JSON.stringify({ name: "declared-runtime", version: "1.0.0", main: "index.js" }),
    );
    await fs.writeFile(path.join(root, "node_modules", "declared-runtime", "index.js"), "");

    expect(() =>
      assertManagedRuntimeExternalImportsResolvable({
        entryPath,
        specifiers: ["node:fs", "fased/plugin-sdk", "declared-runtime"],
      }),
    ).not.toThrow();
    expect(() =>
      assertManagedRuntimeExternalImportsResolvable({
        entryPath,
        specifiers: ["missing-runtime/subpath.js"],
      }),
    ).toThrow(
      "managed component external runtime import is unavailable: missing-runtime/subpath.js",
    );
  });

  it("bundles undeclared shared dependencies and externalizes deployed pack dependencies", () => {
    const deployedDependencies = new Set(["acpx", "@line/bot-sdk"]);
    expect(shouldExternalizeManagedRuntimeImport("node:fs", deployedDependencies)).toBe(true);
    expect(shouldExternalizeManagedRuntimeImport("fased/plugin-sdk", deployedDependencies)).toBe(
      true,
    );
    expect(shouldExternalizeManagedRuntimeImport("acpx", deployedDependencies)).toBe(true);
    expect(
      shouldExternalizeManagedRuntimeImport("@line/bot-sdk/messaging-api", deployedDependencies),
    ).toBe(true);
    expect(
      shouldExternalizeManagedRuntimeImport("@modelcontextprotocol/sdk/server/mcp.js", new Set()),
    ).toBe(false);
  });
});
