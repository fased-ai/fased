import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { rolldown } from "rolldown";
import { managedRuntimeSpecifier } from "../src/plugins/managed-runtime-aliases.js";
import {
  assertCompleteExtensionOwnership,
  readHostedComponentContract,
  type HostedComponentContract,
} from "./hosted-component-contract.js";
import { writeReleaseArchive } from "./release-archive.js";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, "..");

type PluginTreeEntry = {
  path: string;
  mode: number;
  digest?: string;
};

type ManagedCatalogEntry = {
  id: string;
  digest: string;
  archiveDigest: string;
  apiCapability: "fased.plugin.v1";
  required: false;
};

type ManagedPackUsage = {
  archiveBytes: number;
  expandedBytes: number;
  tarStreamBytes: number;
  entries: number;
};

function sha256Bytes(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function sha256File(filePath: string): Promise<string> {
  return sha256Bytes(await fs.readFile(filePath));
}

export async function normalizedManagedPluginTreeDigest(root: string): Promise<string> {
  return (await measureManagedPluginTree(root)).digest;
}

async function measureManagedPluginTree(root: string): Promise<{
  digest: string;
  entries: number;
  expandedBytes: number;
}> {
  const treeEntries: PluginTreeEntry[] = [];
  let expandedBytes = 0;
  const visit = async (directory: string, relativeRoot = ""): Promise<void> => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(relativeRoot, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`managed component contains a symbolic link: ${relative}`);
      }
      if (stat.isDirectory()) {
        treeEntries.push({ path: relative, mode: 0o555 });
        await visit(absolute, relative);
      } else if (stat.isFile()) {
        treeEntries.push({
          path: relative,
          mode: stat.mode & 0o111 ? 0o555 : 0o444,
          digest: await sha256File(absolute),
        });
        expandedBytes += stat.size;
      } else {
        throw new Error(`managed component contains an unsupported entry: ${relative}`);
      }
    }
  };
  await visit(root);
  return {
    digest: sha256Bytes(
      JSON.stringify(treeEntries.toSorted((a, b) => a.path.localeCompare(b.path))),
    ),
    entries: treeEntries.length,
    expandedBytes,
  };
}

async function readPluginIdentity(extensionRoot: string): Promise<{
  id: string;
  packageName: string;
}> {
  const [manifest, packageJson] = await Promise.all([
    fs.readFile(path.join(extensionRoot, "fased.plugin.json"), "utf8"),
    fs.readFile(path.join(extensionRoot, "package.json"), "utf8"),
  ]);
  const id = String((JSON.parse(manifest) as { id?: string }).id ?? "").trim();
  const packageName = String((JSON.parse(packageJson) as { name?: string }).name ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id) || !packageName) {
    throw new Error(`managed component identity is invalid: ${extensionRoot}`);
  }
  return { id, packageName };
}

export function assertManagedComponentPackBudget(params: {
  packId: string;
  budgets: HostedComponentContract["managedTransactionBudgets"];
  usage: ManagedPackUsage;
}): void {
  const { budgets, usage } = params;
  if (
    usage.archiveBytes > budgets.maximumArchiveBytes ||
    usage.expandedBytes > budgets.maximumExpandedBytes ||
    usage.tarStreamBytes > budgets.maximumTarStreamBytes ||
    usage.entries > budgets.maximumEntries
  ) {
    throw new Error(
      `component pack ${params.packId} exceeds P6 transaction budgets ` +
        `(archive ${usage.archiveBytes}/${budgets.maximumArchiveBytes}, expanded ${usage.expandedBytes}/${budgets.maximumExpandedBytes}, tar ${usage.tarStreamBytes}/${budgets.maximumTarStreamBytes}, entries ${usage.entries}/${budgets.maximumEntries})`,
    );
  }
}

async function deployComponentPackage(params: {
  extensionRoot: string;
  packageName: string;
  deployRoot: string;
  stagingRoot: string;
}): Promise<number> {
  const startedAt = Date.now();
  await execFileAsync(
    "pnpm",
    [
      "--config.node-linker=hoisted",
      "--offline",
      "--filter",
      params.packageName,
      "deploy",
      "--prod",
      params.deployRoot,
    ],
    {
      cwd: rootDir,
      env: { ...process.env, npm_config_ignore_scripts: "true" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const bundle = await createManagedRuntimeBundle(params.extensionRoot);
  const generated = await (async () => {
    try {
      return await bundle.write({
        chunkFileNames: "chunks/[name]-[hash].mjs",
        dir: params.deployRoot,
        entryFileNames: "index.mjs",
        format: "esm",
      });
    } finally {
      await bundle.close();
    }
  })();
  assertManagedRuntimeExternalImportsResolvable({
    entryPath: path.join(params.deployRoot, "index.mjs"),
    specifiers: generated.output.flatMap((output) =>
      output.type === "chunk" ? [...output.imports, ...output.dynamicImports] : [],
    ),
  });
  const manifestPath = path.join(params.deployRoot, "package.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
    files?: string[];
    fased?: { extensions?: string[] };
  };
  manifest.files = ["index.mjs", "fased.plugin.json"];
  manifest.fased = { ...manifest.fased, extensions: ["./index.mjs"] };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.rm(path.join(params.deployRoot, "index.ts"), { force: true });
  await fs.cp(params.deployRoot, params.stagingRoot, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
  });
  return Date.now() - startedAt;
}

async function createManagedRuntimeBundle(extensionRoot: string) {
  const manifest = JSON.parse(
    await fs.readFile(path.join(extensionRoot, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const deployedDependencies = new Set(Object.keys(manifest.dependencies ?? {}));
  return await rolldown({
    input: path.join(extensionRoot, "index.ts"),
    external: (id) => shouldExternalizeManagedRuntimeImport(id, deployedDependencies),
    plugins: [
      {
        name: "fased-managed-runtime-boundary",
        async resolveId(source, importer) {
          if (!importer || !source.startsWith(".")) {
            return null;
          }
          const resolved = await this.resolve(source, importer, { skipSelf: true });
          if (!resolved) {
            return null;
          }
          const relative = path.relative(rootDir, resolved.id);
          const specifier = managedRuntimeSpecifier(relative);
          return specifier ? { id: specifier, external: true } : null;
        },
      },
    ],
  });
}

export function shouldExternalizeManagedRuntimeImport(
  id: string,
  deployedDependencies: ReadonlySet<string>,
): boolean {
  if (id.startsWith("node:") || id === "fased" || id.startsWith("fased/")) {
    return true;
  }
  if (id.startsWith(".") || path.isAbsolute(id)) {
    return false;
  }
  const packageName = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];
  return deployedDependencies.has(packageName);
}

export function assertManagedRuntimeExternalImportsResolvable(params: {
  entryPath: string;
  specifiers: Iterable<string>;
}): void {
  const resolveFromComponent = createRequire(params.entryPath).resolve;
  for (const specifier of new Set(params.specifiers)) {
    if (
      specifier.startsWith(".") ||
      path.isAbsolute(specifier) ||
      specifier.startsWith("node:") ||
      specifier === "fased" ||
      specifier.startsWith("fased/")
    ) {
      continue;
    }
    try {
      resolveFromComponent(specifier);
    } catch (error) {
      throw new Error(`managed component external runtime import is unavailable: ${specifier}`, {
        cause: error,
      });
    }
  }
}

function sourceModuleToApplicationPath(moduleId: string): string | null {
  const sourceRoot = path.join(rootDir, "src");
  const relative = path.relative(sourceRoot, moduleId);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !/\.tsx?$/u.test(relative)
  ) {
    return null;
  }
  return path.posix.join("dist", relative.replaceAll(path.sep, "/").replace(/\.tsx?$/u, ".js"));
}

function isManagedRuntimeImplementationPath(
  extensionDirectory: string,
  applicationPath: string,
): boolean {
  // These are configuration/identity/target facades consumed by the core
  // channel registry. They contain no transport, listener, media, or send
  // implementation and remain available before an optional pack is installed.
  const coreChannelFacadePaths = new Set([
    "dist/discord/accounts.js",
    "dist/discord/monitor/allow-list.js",
    "dist/discord/monitor/format.js",
    "dist/discord/monitor/thread-bindings.config.js",
    "dist/discord/monitor/thread-bindings.state.js",
    "dist/discord/monitor/thread-bindings.types.js",
    "dist/discord/targets.js",
    "dist/discord/token.js",
    "dist/imessage/accounts.js",
    "dist/imessage/target-parsing-helpers.js",
    "dist/imessage/targets.js",
    "dist/signal/accounts.js",
    "dist/signal/identity.js",
    "dist/signal/reaction-level.js",
    "dist/slack/accounts.js",
    "dist/slack/monitor/allow-list.js",
    "dist/slack/token.js",
    "dist/slack/targets.js",
    "dist/slack/threading-tool-context.js",
    "dist/telegram/accounts.js",
    "dist/telegram/bot-access.js",
    "dist/telegram/bot/helpers.js",
    "dist/telegram/inline-buttons.js",
    "dist/telegram/model-buttons.js",
    "dist/telegram/reaction-level.js",
    "dist/telegram/targets.js",
    "dist/telegram/token.js",
    "dist/web/accounts.js",
    "dist/web/auth-state.js",
    // Core device pairing renders a small PNG QR code without loading browser,
    // channel, or optional media runtime implementations.
    "dist/web/qr-image.js",
    "dist/whatsapp/normalize.js",
  ]);
  if (coreChannelFacadePaths.has(applicationPath)) {
    return false;
  }
  if (extensionDirectory === "line") {
    return applicationPath.startsWith("dist/line/");
  }
  if (extensionDirectory === "runtime-browser") {
    // Browser profile validation and port allocation are shared configuration
    // semantics used during core onboarding. They do not load browser runtime
    // implementations and must remain available when the optional pack is absent.
    if (applicationPath === "dist/browser/profiles.js") {
      return false;
    }
    return (
      applicationPath.startsWith("dist/browser/") ||
      /^dist\/agents\/tools\/browser-tool(?:\.schema)?\.js$/u.test(applicationPath)
    );
  }
  if (extensionDirectory === "runtime-media") {
    return new Set([
      "dist/media/audio.js",
      "dist/media/fetch.js",
      "dist/media/image-ops.js",
      "dist/media/store.js",
      "dist/web/media.js",
    ]).has(applicationPath);
  }
  if (extensionDirectory === "acpx") {
    return applicationPath === "dist/cli/acp-cli.js" || applicationPath.startsWith("dist/acp/");
  }
  if (extensionDirectory === "discord") {
    return applicationPath.startsWith("dist/discord/");
  }
  if (extensionDirectory === "slack") {
    return (
      applicationPath.startsWith("dist/slack/") ||
      applicationPath.startsWith("dist/agents/tools/slack-actions")
    );
  }
  if (extensionDirectory === "telegram") {
    return applicationPath.startsWith("dist/telegram/");
  }
  if (extensionDirectory === "signal") {
    return applicationPath.startsWith("dist/signal/");
  }
  if (extensionDirectory === "imessage") {
    return applicationPath.startsWith("dist/imessage/");
  }
  if (extensionDirectory === "whatsapp") {
    return (
      applicationPath.startsWith("dist/web/") ||
      applicationPath.startsWith("dist/whatsapp/") ||
      applicationPath.startsWith("dist/channels/web/") ||
      applicationPath.startsWith("dist/agents/tools/whatsapp-actions")
    );
  }
  return (
    applicationPath.startsWith("dist/tts/") ||
    /^dist\/agents\/tools\/tts-tool(?:\.schema)?\.js$/u.test(applicationPath)
  );
}

/** Exact core dist modules whose implementation bytes are owned by managed packs. */
export async function resolveManagedRuntimeImplementationPaths(
  extensionDirectories: readonly string[] = [
    "line",
    "runtime-browser",
    "runtime-media",
    "runtime-speech",
  ],
): Promise<string[]> {
  const paths = new Set<string>();
  for (const extensionDirectory of extensionDirectories) {
    const bundle = await createManagedRuntimeBundle(
      path.join(rootDir, "extensions", extensionDirectory),
    );
    try {
      const generated = await bundle.generate({ format: "esm" });
      for (const output of generated.output) {
        if (output.type !== "chunk") {
          continue;
        }
        for (const moduleId of Object.keys(output.modules)) {
          const applicationPath = sourceModuleToApplicationPath(moduleId);
          if (
            applicationPath &&
            isManagedRuntimeImplementationPath(extensionDirectory, applicationPath)
          ) {
            paths.add(applicationPath);
          }
        }
      }
    } finally {
      await bundle.close();
    }
  }
  return [...paths].toSorted();
}

export async function buildHostedComponentPacks(
  outputDir: string,
  options: { selectedExtensionDirectories?: ReadonlySet<string> } = {},
): Promise<void> {
  const contract = await readHostedComponentContract(
    path.join(rootDir, "config", "hosted-component-packs.json"),
  );
  await assertCompleteExtensionOwnership({
    extensionsRoot: path.join(rootDir, "extensions"),
    contract,
  });
  if (options.selectedExtensionDirectories) {
    const packDirectories = new Set(contract.packs.flatMap((pack) => pack.extensionDirectories));
    const unknown = [...options.selectedExtensionDirectories].filter(
      (directory) => !packDirectories.has(directory),
    );
    if (unknown.length > 0) {
      throw new Error(`unknown optional component directories: ${unknown.toSorted().join(", ")}`);
    }
  }
  const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8")) as {
    version?: string;
  };
  const version = packageJson.version?.trim();
  if (!version) {
    throw new Error("component packs require an exact package version");
  }
  await fs.mkdir(outputDir, { recursive: true });
  const buildScratchRoot = path.join(rootDir, ".artifacts");
  await fs.mkdir(buildScratchRoot, { recursive: true });
  const temporaryRoot = await fs.mkdtemp(path.join(buildScratchRoot, ".component-packs-"));
  try {
    for (const pack of contract.packs) {
      const extensionDirectories = options.selectedExtensionDirectories
        ? pack.extensionDirectories.filter((directory) =>
            options.selectedExtensionDirectories?.has(directory),
          )
        : pack.extensionDirectories;
      if (extensionDirectories.length === 0) {
        continue;
      }
      const components: Array<{
        id: string;
        catalog: { asset: string; sha256: string };
        archive: { asset: string; sha256: string; bytes: number };
      }> = [];
      for (const extensionDirectory of extensionDirectories) {
        const extensionRoot = path.join(rootDir, "extensions", extensionDirectory);
        const identity = await readPluginIdentity(extensionRoot);
        const deployRoot = path.join(temporaryRoot, "deploy", pack.id, identity.id);
        const stagingParent = path.join(temporaryRoot, "staging", pack.id);
        const stagingRoot = path.join(stagingParent, identity.id);
        await fs.mkdir(path.dirname(deployRoot), { recursive: true });
        await fs.mkdir(stagingParent, { recursive: true });
        const deployDurationMs = await deployComponentPackage({
          extensionRoot,
          packageName: identity.packageName,
          deployRoot,
          stagingRoot,
        });
        const tree = await measureManagedPluginTree(stagingParent);
        const asset = `fased-component-${pack.id}-${identity.id}-v${version}.tar.gz`;
        const destination = path.join(outputDir, asset);
        const archive = await writeReleaseArchive({
          cwd: stagingParent,
          destination,
          entries: [identity.id],
          noMtime: true,
          requiredEntryPrefix: `${identity.id}/`,
        });
        const archiveDigest = await sha256File(destination);
        const entry: ManagedCatalogEntry = {
          id: identity.id,
          digest: tree.digest,
          archiveDigest,
          apiCapability: "fased.plugin.v1",
          required: false,
        };
        try {
          assertManagedComponentPackBudget({
            packId: `${pack.id}/${identity.id}`,
            budgets: contract.managedTransactionBudgets,
            usage: {
              archiveBytes: archive.size,
              expandedBytes: tree.expandedBytes,
              tarStreamBytes: archive.rawSize,
              entries: tree.entries,
            },
          });
        } catch (error) {
          await fs.rm(destination, { force: true });
          throw error;
        }
        const catalog = JSON.stringify({
          schemaVersion: 1,
          type: "fased-managed-plugin-catalog",
          entries: [entry],
        });
        const catalogAsset = `fased-component-${pack.id}-${identity.id}-v${version}.catalog.json`;
        await fs.writeFile(path.join(outputDir, catalogAsset), catalog, {
          flag: "wx",
          mode: 0o600,
        });
        const receipt = {
          schemaVersion: 1,
          type: "fased-hosted-component",
          version,
          pack: pack.id,
          component: identity.id,
          catalog: {
            asset: catalogAsset,
            sha256: sha256Bytes(catalog),
          },
          archive: {
            asset,
            sha256: archiveDigest,
            bytes: archive.size,
          },
          transactionUsage: {
            archiveBytes: archive.size,
            expandedBytes: tree.expandedBytes,
            tarStreamBytes: archive.rawSize,
            entries: tree.entries,
          },
          dependencyCache: {
            mode: "offline-pnpm-store",
            downloads: 0,
            durationMs: deployDurationMs,
          },
        };
        await fs.writeFile(
          path.join(
            outputDir,
            `fased-component-${pack.id}-${identity.id}-v${version}.receipt.json`,
          ),
          `${JSON.stringify(receipt, null, 2)}\n`,
          { flag: "wx", mode: 0o600 },
        );
        components.push({
          id: identity.id,
          catalog: { asset: catalogAsset, sha256: sha256Bytes(catalog) },
          archive: { asset, sha256: archiveDigest, bytes: archive.size },
        });
        await fs.rm(stagingRoot, { recursive: true, force: true });
      }
      components.sort((left, right) => left.id.localeCompare(right.id));
      const index = {
        schemaVersion: 1,
        type: "fased-hosted-component-index",
        version,
        pack: pack.id,
        components,
      };
      await fs.writeFile(
        path.join(outputDir, `fased-component-${pack.id}-v${version}.index.json`),
        `${JSON.stringify(index, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
    }
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const outputIndex = process.argv.indexOf("--output");
  const output = process.argv[outputIndex + 1];
  if (outputIndex < 0 || !output) {
    throw new Error("usage: build-hosted-component-packs.ts --output <directory>");
  }
  const componentIndex = process.argv.indexOf("--components");
  const selected = process.argv[componentIndex + 1]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  await buildHostedComponentPacks(
    path.resolve(rootDir, output),
    selected?.length ? { selectedExtensionDirectories: new Set(selected) } : {},
  );
}
