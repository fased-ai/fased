import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertManagedComponentPackBudget,
  assertManagedRuntimeExternalImportsResolvable,
  normalizedManagedPluginTreeDigest,
  resolveManagedRuntimeImplementationPaths,
  shouldExternalizeManagedRuntimeImport,
} from "./build-hosted-component-packs.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed component pack identity", () => {
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
    expect(paths).not.toContain("dist/browser/control-auth.js");
    expect(paths).not.toContain("dist/browser/paths.js");
    expect(paths).not.toContain("dist/browser/proxy-files.js");
    expect(paths).not.toContain("dist/tts/tts.js");
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
    const artifactBuilder = await fs.readFile(
      path.join(process.cwd(), "scripts", "build-hosted-runtime-artifact.ts"),
      "utf8",
    );
    expect(artifactBuilder).toContain('FASED_MANAGED_INTERNAL: "1"');
    expect(artifactBuilder).toContain("writeBundledPluginLock(packageRoot)");
    expect(artifactBuilder).not.toContain('type: "fased-plugin-lock", entries: []');
    expect(artifactBuilder).toContain("allow: componentContract.core.loadedPluginIds");
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
