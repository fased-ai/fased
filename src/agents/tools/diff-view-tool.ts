import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { CANVAS_HOST_PATH } from "../../canvas-host/a2ui.js";
import { resolveStateDir } from "../../config/paths.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const MAX_DIFF_CHARS = 400_000;
const MAX_DIFF_LINES = 2_000;

const DiffViewSchema = Type.Object({
  title: Type.Optional(Type.String()),
  before: Type.Optional(Type.String()),
  after: Type.Optional(Type.String()),
  unifiedDiff: Type.Optional(Type.String()),
});

type DiffLine = {
  kind: "same" | "add" | "remove" | "context" | "header";
  text: string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sanitizeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "diff";
}

function truncateInput(value: string): string {
  return value.length > MAX_DIFF_CHARS ? value.slice(0, MAX_DIFF_CHARS) : value;
}

function classifyPatchLine(line: string): DiffLine {
  if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) {
    return { kind: "header", text: line };
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return { kind: "add", text: line };
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return { kind: "remove", text: line };
  }
  return { kind: "context", text: line };
}

function linesFromPatch(patch: string): DiffLine[] {
  return truncateInput(patch).split(/\r?\n/u).slice(0, MAX_DIFF_LINES).map(classifyPatchLine);
}

function diffBeforeAfter(beforeText: string, afterText: string): DiffLine[] {
  const before = truncateInput(beforeText).split(/\r?\n/u).slice(0, MAX_DIFF_LINES);
  const after = truncateInput(afterText).split(/\r?\n/u).slice(0, MAX_DIFF_LINES);
  const rows = before.length + 1;
  const cols = after.length + 1;
  const dp = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      dp[i][j] =
        before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push({ kind: "same", text: before[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      lines.push({ kind: "remove", text: before[i] ?? "" });
      i += 1;
    } else {
      lines.push({ kind: "add", text: after[j] ?? "" });
      j += 1;
    }
  }
  for (; i < before.length; i += 1) {
    lines.push({ kind: "remove", text: before[i] ?? "" });
  }
  for (; j < after.length; j += 1) {
    lines.push({ kind: "add", text: after[j] ?? "" });
  }
  return lines;
}

function countLines(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.kind === "add").length,
    removed: lines.filter((line) => line.kind === "remove").length,
  };
}

function renderDiffHtml(params: {
  title: string;
  lines: DiffLine[];
  stats: { added: number; removed: number };
}): string {
  const rows = params.lines
    .map((line, index) => {
      const sign =
        line.kind === "add"
          ? "+"
          : line.kind === "remove"
            ? "-"
            : line.kind === "header"
              ? ">"
              : " ";
      return `<tr class="line ${line.kind}"><td class="gutter">${index + 1}</td><td class="sign">${escapeHtml(
        sign,
      )}</td><td class="code">${escapeHtml(line.text || " ")}</td></tr>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(params.title)}</title>
  <style>
    :root { color-scheme: dark light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #050505; color: #f5f5f5; }
    main { min-height: 100vh; padding: 20px; box-sizing: border-box; }
    header { display: flex; justify-content: space-between; gap: 12px; align-items: center; border-bottom: 1px solid #242424; padding-bottom: 14px; }
    h1 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: 0; }
    .stats { display: flex; gap: 10px; color: #a3a3a3; font-size: 13px; }
    .stats b { color: #fff; }
    .viewer { margin-top: 16px; border: 1px solid #242424; border-radius: 8px; overflow: auto; max-height: calc(100vh - 92px); background: #0b0b0b; }
    table { width: 100%; border-collapse: collapse; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    td { vertical-align: top; border-bottom: 1px solid rgba(255,255,255,0.035); }
    .gutter { width: 56px; color: #737373; text-align: right; padding: 1px 12px; user-select: none; }
    .sign { width: 24px; color: #9ca3af; text-align: center; user-select: none; }
    .code { white-space: pre-wrap; overflow-wrap: anywhere; padding: 1px 14px 1px 0; }
    .add { background: rgba(22, 163, 74, 0.14); }
    .remove { background: rgba(220, 38, 38, 0.14); }
    .header { background: rgba(148, 163, 184, 0.12); color: #d4d4d4; }
    @media (prefers-color-scheme: light) {
      body { background: #fff; color: #111; }
      header { border-color: #ddd; }
      .stats b { color: #111; }
      .viewer { background: #fff; border-color: #ddd; }
      td { border-bottom-color: rgba(0,0,0,0.055); }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(params.title)}</h1>
      <div class="stats"><span><b>${params.stats.added}</b> added</span><span><b>${params.stats.removed}</b> removed</span></div>
    </header>
    <section class="viewer" aria-label="Diff viewer">
      <table><tbody>${rows}</tbody></table>
    </section>
  </main>
</body>
</html>
`;
}

export function createDiffViewTool(): AnyAgentTool {
  return {
    label: "Diff Viewer",
    name: "diff_view",
    description:
      "Create a Fased canvas-style HTML diff viewer from before/after text or a unified diff. Returns a local canvas URL and file path.",
    parameters: DiffViewSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const title = readStringParam(params, "title", { trim: true }) ?? "Diff";
      const unifiedDiff = readStringParam(params, "unifiedDiff", { trim: false });
      const before = readStringParam(params, "before", { trim: false });
      const after = readStringParam(params, "after", { trim: false });
      if (!unifiedDiff && (before === undefined || after === undefined)) {
        throw new Error("Provide unifiedDiff, or both before and after.");
      }
      const lines = unifiedDiff
        ? linesFromPatch(unifiedDiff)
        : diffBeforeAfter(before ?? "", after ?? "");
      const stats = countLines(lines);
      const id = `${new Date()
        .toISOString()
        .replace(/[^0-9]/g, "")
        .slice(0, 14)}-${crypto.randomBytes(4).toString("hex")}`;
      const fileName = `${sanitizeSlug(title)}-${id}.html`;
      const dir = path.join(resolveStateDir(), "canvas", "diffs");
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, fileName);
      await fs.writeFile(filePath, renderDiffHtml({ title, lines, stats }), "utf8");
      return jsonResult({
        ok: true,
        title,
        added: stats.added,
        removed: stats.removed,
        lines: lines.length,
        filePath,
        canvasUrl: `${CANVAS_HOST_PATH}/diffs/${fileName}`,
      });
    },
  };
}
