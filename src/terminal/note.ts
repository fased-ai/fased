import { visibleWidth } from "./ansi.js";
import { theme } from "./theme.js";

const URL_PREFIX_RE = /^(https?:\/\/|file:\/\/)/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const FILE_LIKE_RE = /^[a-zA-Z0-9._-]+$/;

function splitLongWord(word: string, maxLen: number): string[] {
  if (maxLen <= 0) {
    return [word];
  }
  const chars = Array.from(word);
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += maxLen) {
    parts.push(chars.slice(i, i + maxLen).join(""));
  }
  return parts.length > 0 ? parts : [word];
}

function isCopySensitiveToken(word: string): boolean {
  if (!word) {
    return false;
  }
  if (URL_PREFIX_RE.test(word)) {
    return true;
  }
  if (
    word.startsWith("/") ||
    word.startsWith("~/") ||
    word.startsWith("./") ||
    word.startsWith("../")
  ) {
    return true;
  }
  if (WINDOWS_DRIVE_RE.test(word) || word.startsWith("\\\\")) {
    return true;
  }
  if (word.includes("/") || word.includes("\\")) {
    return true;
  }
  // Preserve common file-like tokens (for example administrators_authorized_keys).
  return word.includes("_") && FILE_LIKE_RE.test(word);
}

function wrapLine(line: string, maxWidth: number): string[] {
  if (line.trim().length === 0) {
    return [line];
  }
  const match = line.match(/^(\s*)([-*\u2022]\s+)?(.*)$/);
  const indent = match?.[1] ?? "";
  const bullet = match?.[2] ?? "";
  const content = match?.[3] ?? "";
  const firstPrefix = `${indent}${bullet}`;
  const nextPrefix = `${indent}${bullet ? " ".repeat(bullet.length) : ""}`;
  const firstWidth = Math.max(10, maxWidth - visibleWidth(firstPrefix));
  const nextWidth = Math.max(10, maxWidth - visibleWidth(nextPrefix));

  const words = content.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  let prefix = firstPrefix;
  let available = firstWidth;

  for (const word of words) {
    if (!current) {
      if (visibleWidth(word) > available) {
        if (isCopySensitiveToken(word)) {
          current = word;
          continue;
        }
        const parts = splitLongWord(word, available);
        const first = parts.shift() ?? "";
        lines.push(prefix + first);
        prefix = nextPrefix;
        available = nextWidth;
        for (const part of parts) {
          lines.push(prefix + part);
        }
        continue;
      }
      current = word;
      continue;
    }

    const candidate = `${current} ${word}`;
    if (visibleWidth(candidate) <= available) {
      current = candidate;
      continue;
    }

    lines.push(prefix + current);
    prefix = nextPrefix;
    available = nextWidth;

    if (visibleWidth(word) > available) {
      if (isCopySensitiveToken(word)) {
        current = word;
        continue;
      }
      const parts = splitLongWord(word, available);
      const first = parts.shift() ?? "";
      lines.push(prefix + first);
      for (const part of parts) {
        lines.push(prefix + part);
      }
      current = "";
      continue;
    }
    current = word;
  }

  if (current || words.length === 0) {
    lines.push(prefix + current);
  }

  return lines;
}

export function wrapNoteMessage(
  message: string,
  options: { maxWidth?: number; columns?: number } = {},
): string {
  const columns = options.columns ?? process.stdout.columns ?? 80;
  const maxWidth = options.maxWidth ?? Math.max(40, Math.min(88, columns - 10));
  return message
    .split("\n")
    .flatMap((line) => wrapLine(line, maxWidth))
    .join("\n");
}

function formatNoteTitle(title?: string): string | undefined {
  const value = title?.trim();
  return value ? theme.noteTitle(value.toUpperCase()) : undefined;
}

function padVisible(value: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(value));
  return `${value}${" ".repeat(padding)}`;
}

export function formatFramedBlock(
  lines: string[],
  title?: string,
  options: { indent?: string; minWidth?: number } = {},
): string[] {
  const indent = options.indent ?? "  ";
  const titleText = formatNoteTitle(title);
  const minWidth = options.minWidth ?? 48;
  const contentWidth = Math.max(
    minWidth,
    ...lines.map((line) => visibleWidth(line)),
    titleText ? visibleWidth(titleText) + 4 : 0,
  );
  const topInnerWidth = contentWidth + 2;
  const titleWidth = titleText ? visibleWidth(titleText) : 0;
  const titlePrefixWidth = titleText ? titleWidth + 3 : 0;
  const topRule = "─".repeat(Math.max(0, topInnerWidth - titlePrefixWidth));
  const top = titleText
    ? `${indent}${theme.noteChrome("╭")}${theme.noteChrome("─ ")}${titleText}${theme.noteChrome(
        ` ${topRule}╮`,
      )}`
    : `${indent}${theme.noteChrome(`╭${"─".repeat(topInnerWidth)}╮`)}`;
  const body = lines.map(
    (line) =>
      `${indent}${theme.noteChrome("│")} ${padVisible(line, contentWidth)} ${theme.noteChrome("│")}`,
  );
  const bottom = `${indent}${theme.noteChrome(`╰${"─".repeat(topInnerWidth)}╯`)}`;
  return [top, ...body, bottom];
}

export function note(message: string, title?: string) {
  const wrapped = wrapNoteMessage(message);
  const lines = wrapped.split("\n");
  const output = formatFramedBlock(lines, title);
  process.stdout.write(`${output.join("\n")}\n`);
}
