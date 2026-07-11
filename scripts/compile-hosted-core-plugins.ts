import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const CORE_PLUGIN_IDS = ["memory-core", "sat-mining"] as const;

function rewriteCorePackageImports(
  source: string,
  entryPoint: string,
  packageRoot: string,
): string {
  const pluginSdkDir = path.join(packageRoot, "dist", "plugin-sdk");
  const relativePluginSdkDir = path
    .relative(path.dirname(entryPoint), pluginSdkDir)
    .split(path.sep)
    .join("/");
  const pluginSdkSpecifier = relativePluginSdkDir.startsWith(".")
    ? relativePluginSdkDir
    : `./${relativePluginSdkDir}`;
  return source
    .replaceAll('"fased/plugin-sdk/sat-runtime"', `"${pluginSdkSpecifier}/sat-runtime.js"`)
    .replaceAll("'fased/plugin-sdk/sat-runtime'", `'${pluginSdkSpecifier}/sat-runtime.js'`)
    .replaceAll('"fased/plugin-sdk"', `"${pluginSdkSpecifier}/index.js"`)
    .replaceAll("'fased/plugin-sdk'", `'${pluginSdkSpecifier}/index.js'`);
}

async function collectRuntimeTypeScriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(fullPath);
      }
    }
  };
  await visit(root);
  return files.toSorted();
}

async function compilePlugin(packageRoot: string, pluginId: string): Promise<void> {
  const pluginRoot = path.join(packageRoot, "extensions", pluginId);
  const entryPoints = await collectRuntimeTypeScriptFiles(pluginRoot);
  if (entryPoints.length === 0) {
    throw new Error(`No runtime TypeScript files found for ${pluginId}.`);
  }
  for (const entryPoint of entryPoints) {
    const source = await fs.readFile(entryPoint, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        sourceMap: false,
      },
      fileName: entryPoint,
      reportDiagnostics: true,
    });
    const errors = (compiled.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    if (errors.length > 0) {
      throw new Error(
        `Could not compile ${entryPoint}: ${errors
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
          .join("; ")}`,
      );
    }
    await fs.writeFile(
      entryPoint.replace(/\.ts$/, ".js"),
      rewriteCorePackageImports(compiled.outputText, entryPoint, packageRoot),
      "utf8",
    );
    await fs.rm(entryPoint);
  }

  const packagePath = path.join(pluginRoot, "package.json");
  const manifest = JSON.parse(await fs.readFile(packagePath, "utf8")) as {
    main?: string;
    exports?: Record<string, string>;
    fased?: { extensions?: string[] };
  };
  manifest.main = "./index.js";
  manifest.exports = { ".": "./index.js" };
  if (manifest.fased?.extensions) {
    manifest.fased.extensions = ["./index.js"];
  }
  await fs.writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

const rootFlag = process.argv.indexOf("--root");
const packageRoot = path.resolve(process.argv[rootFlag + 1] ?? "");
if (rootFlag < 0 || !packageRoot) {
  throw new Error("usage: compile-hosted-core-plugins.ts --root <package-root>");
}

for (const pluginId of CORE_PLUGIN_IDS) {
  await compilePlugin(packageRoot, pluginId);
  console.log(`hosted-artifact: compiled ${pluginId} runtime plugin`);
}
