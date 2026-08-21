import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const rootDir = path.resolve(import.meta.dirname, "..");

const roots = ["src/gateway/server.impl.ts", "src/plugins/runtime/index.ts"] as const;

const forbidden = new Map([
  ["src/media/audio.ts", "media audio implementation"],
  ["src/media/fetch.ts", "media fetch implementation"],
  ["src/media/image-ops.ts", "media image implementation"],
  ["src/media/store.ts", "media store implementation"],
  ["src/web/media.ts", "web media implementation"],
  ["src/tts/tts.ts", "speech implementation"],
  ["src/signal/send.ts", "Signal transport implementation"],
]);

const forbiddenStaticPackages = new Map([
  ["@mariozechner/pi-ai/compat", "eager pi-ai provider catalog"],
]);

function hasRuntimeImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) {
    return true;
  }
  if (clause.isTypeOnly) {
    return false;
  }
  if (clause.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))) {
    return true;
  }
  return clause.namedBindings?.elements.some((element) => !element.isTypeOnly) ?? false;
}

function runtimeSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      hasRuntimeImport(statement)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

async function resolveSource(fromPath: string, specifier: string): Promise<string | null> {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const raw = path.resolve(path.dirname(fromPath), specifier);
  const candidates = [
    raw,
    raw.replace(/\.(?:m?js|cjs)$/u, ".ts"),
    raw.replace(/\.(?:m?js|cjs)$/u, ".tsx"),
    path.join(raw, "index.ts"),
    path.join(raw, "index.tsx"),
  ];
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) {
        return candidate;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  throw new Error(
    `Gateway closure could not resolve ${specifier} imported by ${path.relative(rootDir, fromPath)}`,
  );
}

export async function collectGatewayStaticClosure(): Promise<string[]> {
  const pending = roots.map((entry) => path.join(rootDir, entry));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const sourceText = await fs.readFile(current, "utf8");
    const source = ts.createSourceFile(current, sourceText, ts.ScriptTarget.Latest, true);
    for (const specifier of runtimeSpecifiers(source)) {
      const resolved = await resolveSource(current, specifier);
      if (resolved && !visited.has(resolved)) {
        pending.push(resolved);
      }
    }
  }
  return [...visited]
    .map((entry) => path.relative(rootDir, entry).replaceAll(path.sep, "/"))
    .toSorted();
}

export async function assertGatewayOptionalRuntimeClosure(): Promise<string[]> {
  const closure = await collectGatewayStaticClosure();
  const failures = closure
    .filter((entry) => forbidden.has(entry))
    .map((entry) => `${entry} (${forbidden.get(entry)})`);
  for (const entry of closure) {
    const sourcePath = path.join(rootDir, entry);
    const sourceText = await fs.readFile(sourcePath, "utf8");
    const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
    for (const specifier of runtimeSpecifiers(source)) {
      const reason = forbiddenStaticPackages.get(specifier);
      if (reason) {
        failures.push(`${entry} -> ${specifier} (${reason})`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Gateway static closure contains optional implementations: ${failures.join(", ")}`,
    );
  }
  return closure;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const closure = await assertGatewayOptionalRuntimeClosure();
  console.log(
    `Gateway optional-runtime closure PASS: ${closure.length} source modules; 0 forbidden edges.`,
  );
}
