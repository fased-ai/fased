import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCompleteExtensionOwnership,
  assertHostedCoreBudgets,
  assertPackDependencyIsolation,
  enforceHostedApplicationAllowlist,
  measureRegularFiles,
  pruneHostedDependencies,
  readHostedComponentContract,
  retainHostedCoreExtensions,
} from "./hosted-component-contract.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-component-contract-"));
  roots.push(root);
  const extensionsRoot = path.join(root, "extensions");
  await fs.mkdir(extensionsRoot);
  for (const directory of ["core-a", "shared", "optional-a", "test-utils"]) {
    await fs.mkdir(path.join(extensionsRoot, directory));
    await fs.writeFile(path.join(extensionsRoot, directory, "index.js"), directory);
  }
  const contractPath = path.join(root, "contract.json");
  await fs.writeFile(
    contractPath,
    `${JSON.stringify({
      schemaVersion: 1,
      core: {
        allowedApplicationTopLevelEntries: ["assets", "extensions"],
        excludedApplicationPaths: ["assets/chrome-extension"],
        extensionDirectories: ["core-a"],
        sharedDirectories: ["shared"],
        loadedPluginIds: ["core-a"],
        maximumApplicationFiles: 4,
        maximumApplicationBytes: 1024,
        maximumDependencyFiles: 2,
        maximumDependencyBytes: 1024,
        excludedDependencyPackages: ["typescript"],
        allowedSharedPackDependencies: [],
      },
      managedTransactionBudgets: {
        maximumArchiveBytes: 1024,
        maximumExpandedBytes: 2048,
        maximumTarStreamBytes: 4096,
        maximumEntries: 32,
      },
      packs: [{ id: "optional", extensionDirectories: ["optional-a"] }],
      ignoredDirectories: ["test-utils"],
    })}\n`,
  );
  return {
    root,
    extensionsRoot,
    contract: await readHostedComponentContract(contractPath),
  };
}

describe("hosted component contract", () => {
  it("enforces exact application entries and removes only declared optional assets", async () => {
    const value = await fixture();
    const packageRoot = path.join(value.root, "application");
    await fs.mkdir(path.join(packageRoot, "assets", "chrome-extension"), { recursive: true });
    await fs.mkdir(path.join(packageRoot, "extensions"));
    await expect(
      enforceHostedApplicationAllowlist({ packageRoot, contract: value.contract }),
    ).resolves.toEqual(["assets/chrome-extension"]);
    await fs.mkdir(path.join(packageRoot, "unexpected"));
    await expect(
      enforceHostedApplicationAllowlist({ packageRoot, contract: value.contract }),
    ).rejects.toThrow("unexpected: unexpected");
  });

  it("requires exact ownership and retains only core extension directories", async () => {
    const value = await fixture();
    await expect(
      assertCompleteExtensionOwnership({
        extensionsRoot: value.extensionsRoot,
        contract: value.contract,
      }),
    ).resolves.toBeUndefined();
    await expect(
      retainHostedCoreExtensions({
        extensionsRoot: value.extensionsRoot,
        contract: value.contract,
      }),
    ).resolves.toEqual(["optional-a", "test-utils"]);
    await expect(fs.readdir(value.extensionsRoot)).resolves.toEqual(["core-a", "shared"]);
  });

  it("allows test-only directories to be absent from the packaged tree", async () => {
    const value = await fixture();
    await fs.rm(path.join(value.extensionsRoot, "test-utils"), { recursive: true });
    await expect(
      retainHostedCoreExtensions({
        extensionsRoot: value.extensionsRoot,
        contract: value.contract,
      }),
    ).resolves.toEqual(["optional-a"]);
    const missingPack = await fixture();
    await fs.rm(path.join(missingPack.extensionsRoot, "optional-a"), { recursive: true });
    await expect(
      retainHostedCoreExtensions({
        extensionsRoot: missingPack.extensionsRoot,
        contract: missingPack.contract,
      }),
    ).rejects.toThrow("missing: optional-a");
  });

  it("rejects unclassified extension directories and budget overflow", async () => {
    const value = await fixture();
    await fs.mkdir(path.join(value.extensionsRoot, "unknown"));
    await expect(
      assertCompleteExtensionOwnership({
        extensionsRoot: value.extensionsRoot,
        contract: value.contract,
      }),
    ).rejects.toThrow("unknown: unknown");
    expect(() =>
      assertHostedCoreBudgets({
        contract: value.contract,
        application: { files: 5, bytes: 100 },
        dependencies: { files: 1, bytes: 100 },
      }),
    ).toThrow("Hosted application exceeds core budget");
  });

  it("measures only regular files outside excluded top-level roots", async () => {
    const value = await fixture();
    const packageRoot = path.join(value.root, "package");
    await fs.mkdir(path.join(packageRoot, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "app.js"), "app");
    await fs.writeFile(path.join(packageRoot, "node_modules", "dep.js"), "dependency");
    await expect(
      measureRegularFiles(packageRoot, { excludeTopLevel: new Set(["node_modules"]) }),
    ).resolves.toEqual({ files: 1, bytes: 3 });
  });

  it("removes runtime-irrelevant dependency files before applying budgets", async () => {
    const value = await fixture();
    const modules = path.join(value.root, "node_modules");
    await fs.mkdir(path.join(modules, "pkg"), { recursive: true });
    await fs.writeFile(path.join(modules, "pkg", "index.js"), "runtime");
    await fs.writeFile(path.join(modules, "pkg", "index.d.ts"), "type");
    await fs.writeFile(path.join(modules, "pkg", "index.js.map"), "map");
    await fs.mkdir(path.join(modules, "typescript"), { recursive: true });
    await fs.writeFile(path.join(modules, "typescript", "typescript.js"), "compiler");
    await expect(pruneHostedDependencies(modules, "x64", ["typescript"])).resolves.toEqual({
      files: 1,
      bytes: 7,
    });
    await expect(fs.readdir(path.join(modules, "pkg"))).resolves.toEqual(["index.js"]);
    await expect(fs.stat(path.join(modules, "typescript"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("classifies every repository extension directory exactly once", async () => {
    const contract = await readHostedComponentContract(
      path.join(process.cwd(), "config", "hosted-component-packs.json"),
    );
    expect(contract.core.loadedPluginIds).toEqual(["device-pair", "memory-core", "sat-mining"]);
    await expect(
      assertCompleteExtensionOwnership({
        extensionsRoot: path.join(process.cwd(), "extensions"),
        contract,
      }),
    ).resolves.toBeUndefined();
    const p6Source = await fs.readFile(
      path.join(
        process.cwd(),
        "tools",
        "fased-lifecycled",
        "platform",
        "managed_plugin_transaction.go",
      ),
      "utf8",
    );
    expect(p6Source).toContain("maxManagedPluginArchiveBytes    = 256 * 1024 * 1024");
    expect(p6Source).toContain("maxManagedPluginExpandedBytes   = 512 * 1024 * 1024");
    expect(p6Source).toContain("maxManagedPluginTarStreamBytes = 640 * 1024 * 1024");
    expect(p6Source).toContain("maxManagedPluginArchiveEntries = 100_000");
    const artifactSource = await fs.readFile(
      path.join(process.cwd(), "scripts", "build-hosted-runtime-artifact.ts"),
      "utf8",
    );
    expect(artifactSource).toContain("loadedPlugins: componentContract.core.loadedPluginIds");
    expect(artifactSource).toContain('mode: "offline-pnpm-store"');
    expect(artifactSource).toContain("downloads: 0");
    expect(artifactSource).toContain("excludedExtensions: removedExtensions");
    expect(artifactSource).toContain(
      "excludedManagedRuntimePaths: managedRuntimeImplementationPaths",
    );
    expect(artifactSource).toContain("candidateManagedRuntimeImplementationPaths");
    expect(artifactSource).toContain('code === "ENOENT"');
    expect(artifactSource).toContain("managedRuntimeImplementationPaths.push(relative)");
    expect(artifactSource).toContain("componentContract.core.excludedDependencyPackages");
    expect(artifactSource).toContain('for (const id of ["typescript", "@fedify/vocab-tools"])');
    expect(artifactSource).toContain('].join("\\n")');
    expect(artifactSource).not.toContain('].join(";")');
    expect(artifactSource).toContain("extensions/sat-mining/implementation.js");
    expect(artifactSource).toContain("Dormant SAT Mining loaded its operational implementation");
    for (const packageName of [
      "@anthropic-ai/sdk",
      "@aws-sdk/client-bedrock-runtime",
      "@google/genai",
      "@mistralai/mistralai",
      "openai",
    ]) {
      expect(artifactSource).toContain(`"${packageName}"`);
    }
    expect(artifactSource).toContain('packaging: "upstream-unconditional-dependencies"');
    expect(artifactSource).toContain("gatewayReadyRssBytes");
    const doctorConfigSource = await fs.readFile(
      path.join(process.cwd(), "src", "commands", "doctor-config-flow.ts"),
      "utf8",
    );
    expect(doctorConfigSource).not.toContain('from "../telegram/accounts.js"');
    expect(doctorConfigSource).not.toContain('from "../channels/telegram/api.js"');
    expect(doctorConfigSource).toContain('import("../telegram/accounts.js")');
    expect(doctorConfigSource).toContain('import("../channels/telegram/api.js")');
    const pluginAutoEnableSource = await fs.readFile(
      path.join(process.cwd(), "src", "config", "plugin-auto-enable.ts"),
      "utf8",
    );
    expect(pluginAutoEnableSource).not.toContain('from "../web/accounts.js"');
    expect(pluginAutoEnableSource).toContain('path.join(authDir, "creds.json")');
    const packageEntrypointSource = await fs.readFile(
      path.join(process.cwd(), "src", "index.ts"),
      "utf8",
    );
    expect(packageEntrypointSource).not.toContain(
      'import { getReplyFromConfig } from "./auto-reply/reply.js"',
    );
    expect(packageEntrypointSource).toContain('await import("./auto-reply/reply.js")');
    const cliDepsSource = await fs.readFile(
      path.join(process.cwd(), "src", "cli", "deps.ts"),
      "utf8",
    );
    expect(cliDepsSource).not.toContain('export { logWebSelfId } from "../web/auth-store.js"');
    const componentPackSource = await fs.readFile(
      path.join(process.cwd(), "scripts", "build-hosted-component-packs.ts"),
      "utf8",
    );
    expect(componentPackSource).toContain("const coreChannelFacadePaths = new Set(");
    for (const facade of [
      "dist/discord/accounts.js",
      "dist/discord/token.js",
      "dist/imessage/accounts.js",
      "dist/signal/accounts.js",
      "dist/slack/accounts.js",
      "dist/slack/token.js",
      "dist/slack/targets.js",
      "dist/slack/threading-tool-context.js",
      "dist/telegram/accounts.js",
      "dist/telegram/token.js",
      "dist/web/accounts.js",
      "dist/web/auth-state.js",
      "dist/whatsapp/normalize.js",
    ]) {
      expect(componentPackSource).toContain(`"${facade}"`);
    }
    const runtimeGraphSource = await fs.readFile(
      path.join(process.cwd(), "scripts", "build-runtime-graphs.mjs"),
      "utf8",
    );
    expect(runtimeGraphSource).not.toContain('runGraph("sdk")');
    const tsdownSource = await fs.readFile(path.join(process.cwd(), "tsdown.config.ts"), "utf8");
    expect(tsdownSource).toContain("pluginSdkEntryMap");
    expect(tsdownSource).toContain("Object.fromEntries");
    expect(tsdownSource).toContain("`plugin-sdk/${name}`");
    const rootPackage = JSON.parse(
      await fs.readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(rootPackage.scripts?.["deadcode:ci"]).toContain("deadcode:reachability");
    expect(rootPackage.devDependencies).toMatchObject({
      knip: "6.32.2",
      "ts-prune": "0.10.3",
      "ts-unused-exports": "11.0.1",
    });
    await expect(
      assertPackDependencyIsolation({
        rootPackagePath: path.join(process.cwd(), "package.json"),
        extensionsRoot: path.join(process.cwd(), "extensions"),
        contract,
      }),
    ).resolves.toBeUndefined();
  });
});
