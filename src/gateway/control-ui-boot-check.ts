import fs from "node:fs";
import path from "node:path";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { resolveControlUiRootSync } from "../infra/control-ui-assets.js";
import { isWithinDir } from "../infra/path-safety.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import type { ControlUiRootState } from "./control-ui.js";

export const CONTROL_UI_BOOT_CHECK_PATH = "/api/control-ui/boot-check";

export type ControlUiBootCheckAsset = {
  url: string;
  ok: boolean;
  status: number;
  contentType: string;
  message?: string;
};

export type ControlUiBootCheck = {
  index: "ok" | "failed";
  indexResponse: ControlUiBootCheckAsset;
  entryJs: ControlUiBootCheckAsset | null;
  appJs: ControlUiBootCheckAsset | null;
  serve: "tailscale" | "direct" | "unknown";
};

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function normalizeBootCheckOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return "http://localhost";
  }
}

function buildBootCheckUrl(params: { origin: string; basePath: string; rel?: string }): string {
  const origin = normalizeBootCheckOrigin(params.origin);
  const basePath = normalizeControlUiBasePath(params.basePath);
  if (!params.rel) {
    return basePath ? `${origin}${basePath}/` : `${origin}/`;
  }
  const rel = params.rel.replace(/^\/+/, "");
  return `${origin}${basePath}/${rel}`;
}

function resolveAssetUrl(src: string, baseUrl: string): string | null {
  const trimmed = src.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractHtmlScriptAssetUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const resolved = resolveAssetUrl(match[1] ?? "", baseUrl);
    if (resolved && /\.js(?:[?#].*)?$/i.test(resolved)) {
      urls.add(resolved);
    }
  }
  return [...urls];
}

function extractDynamicImportUrls(js: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  for (const match of js.matchAll(/\bimport\(\s*["']([^"']+\.js)["']\s*\)/g)) {
    const resolved = resolveAssetUrl(match[1] ?? "", baseUrl);
    if (resolved) {
      urls.add(resolved);
    }
  }
  return [...urls];
}

function urlPathnameLower(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function isLikelyAppJsUrl(url: string): boolean {
  const basename = urlPathnameLower(url).split("/").pop() ?? "";
  return /^app-[^.]+\.js$/.test(basename);
}

function isExpectedSafePathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function isSafeRelativePath(relPath: string) {
  if (!relPath) {
    return false;
  }
  const normalized = path.posix.normalize(relPath);
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    return false;
  }
  if (normalized.startsWith("../") || normalized === "..") {
    return false;
  }
  if (normalized.includes("\0")) {
    return false;
  }
  return true;
}

function resolveSafeControlUiFile(
  rootReal: string,
  filePath: string,
): { path: string; fd: number } | null {
  const opened = openBoundaryFileSync({
    absolutePath: filePath,
    rootPath: rootReal,
    rootRealPath: rootReal,
    boundaryLabel: "control ui root",
    skipLexicalRootCheck: true,
  });
  if (!opened.ok) {
    if (opened.reason === "io") {
      throw opened.error;
    }
    return null;
  }
  return { path: opened.path, fd: opened.fd };
}

function controlUiRelativePathFromUrl(params: {
  url: string;
  origin: string;
  basePath: string;
}): string | null {
  try {
    const parsed = new URL(params.url, normalizeBootCheckOrigin(params.origin));
    const basePath = normalizeControlUiBasePath(params.basePath);
    let pathname = decodeURIComponent(parsed.pathname);
    if (basePath) {
      if (!pathname.startsWith(`${basePath}/`)) {
        return null;
      }
      pathname = pathname.slice(basePath.length);
    }
    if (!pathname.startsWith("/")) {
      return null;
    }
    const rel = pathname.slice(1);
    return rel || null;
  } catch {
    return null;
  }
}

function missingBootAsset(url: string, status: number, message: string): ControlUiBootCheckAsset {
  return {
    url,
    ok: false,
    status,
    contentType: "text/plain; charset=utf-8",
    message,
  };
}

function readControlUiBootAsset(params: {
  root: string;
  rootReal: string;
  url: string;
  origin: string;
  basePath: string;
}): { check: ControlUiBootCheckAsset; text: string } {
  const rel = controlUiRelativePathFromUrl({
    url: params.url,
    origin: params.origin,
    basePath: params.basePath,
  });
  if (!rel || !isSafeRelativePath(rel)) {
    return { check: missingBootAsset(params.url, 404, "asset path is invalid"), text: "" };
  }
  const filePath = path.resolve(params.root, rel);
  if (!isWithinDir(params.root, filePath)) {
    return {
      check: missingBootAsset(params.url, 404, "asset path is outside control ui root"),
      text: "",
    };
  }
  const safeFile = resolveSafeControlUiFile(params.rootReal, filePath);
  if (!safeFile) {
    return { check: missingBootAsset(params.url, 404, "asset file is missing"), text: "" };
  }
  try {
    const body = fs.readFileSync(safeFile.fd);
    return {
      check: {
        url: params.url,
        ok: true,
        status: 200,
        contentType: contentTypeForExt(path.extname(safeFile.path).toLowerCase()),
      },
      text: body.toString("utf8"),
    };
  } finally {
    fs.closeSync(safeFile.fd);
  }
}

function resolveBootCheckRoot(
  rootState: ControlUiRootState | undefined,
): { ok: true; root: string; rootReal: string } | { ok: false; message: string } {
  if (rootState?.kind === "invalid") {
    return { ok: false, message: `Control UI assets not found at ${rootState.path}.` };
  }
  if (rootState?.kind === "missing") {
    return { ok: false, message: "Control UI assets not found." };
  }
  const root =
    rootState?.kind === "resolved"
      ? rootState.path
      : resolveControlUiRootSync({
          moduleUrl: import.meta.url,
          argv1: process.argv[1],
          cwd: process.cwd(),
        });
  if (!root) {
    return { ok: false, message: "Control UI assets not found." };
  }
  try {
    return { ok: true, root, rootReal: fs.realpathSync(root) };
  } catch (error) {
    if (isExpectedSafePathError(error)) {
      return { ok: false, message: "Control UI assets not found." };
    }
    throw error;
  }
}

export function resolveControlUiBootCheck(params: {
  basePath?: string;
  root?: ControlUiRootState;
  origin: string;
  serve?: "tailscale" | "direct" | "unknown";
}): ControlUiBootCheck {
  const basePath = normalizeControlUiBasePath(params.basePath);
  const origin = normalizeBootCheckOrigin(params.origin);
  const indexUrl = buildBootCheckUrl({ origin, basePath });
  const root = resolveBootCheckRoot(params.root);
  const failedIndex = (message: string, status = 503): ControlUiBootCheck => ({
    index: "failed",
    indexResponse: missingBootAsset(indexUrl, status, message),
    entryJs: null,
    appJs: null,
    serve: params.serve ?? "unknown",
  });
  if (!root.ok) {
    return failedIndex(root.message);
  }

  const indexPath = path.join(root.root, "index.html");
  const safeIndex = resolveSafeControlUiFile(root.rootReal, indexPath);
  if (!safeIndex) {
    return failedIndex("index.html is missing", 404);
  }

  let html = "";
  try {
    html = fs.readFileSync(safeIndex.fd, "utf8");
  } finally {
    fs.closeSync(safeIndex.fd);
  }

  const entryJsUrl = extractHtmlScriptAssetUrls(html, indexUrl)[0] ?? null;
  const entry =
    entryJsUrl == null
      ? {
          check: missingBootAsset("", 404, "index.html did not reference an entry JS bundle"),
          text: "",
        }
      : readControlUiBootAsset({
          root: root.root,
          rootReal: root.rootReal,
          url: entryJsUrl,
          origin,
          basePath,
        });
  const dynamicUrls = entry.check.ok ? extractDynamicImportUrls(entry.text, entry.check.url) : [];
  const appJsUrl = dynamicUrls.find(isLikelyAppJsUrl) ?? dynamicUrls[0] ?? null;
  const app =
    appJsUrl == null
      ? null
      : readControlUiBootAsset({
          root: root.root,
          rootReal: root.rootReal,
          url: appJsUrl,
          origin,
          basePath,
        }).check;

  return {
    index: "ok",
    indexResponse: {
      url: indexUrl,
      ok: true,
      status: 200,
      contentType: "text/html; charset=utf-8",
    },
    entryJs: entry.check.url ? entry.check : null,
    appJs: app,
    serve: params.serve ?? "unknown",
  };
}
