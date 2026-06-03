export const INTERNAL_RUNTIME_CONTEXT_BEGIN = "<<<BEGIN_FASED_INTERNAL_CONTEXT>>>";
export const INTERNAL_RUNTIME_CONTEXT_END = "<<<END_FASED_INTERNAL_CONTEXT>>>";

const ESCAPED_INTERNAL_RUNTIME_CONTEXT_BEGIN = "[[FASED_INTERNAL_CONTEXT_BEGIN]]";
const ESCAPED_INTERNAL_RUNTIME_CONTEXT_END = "[[FASED_INTERNAL_CONTEXT_END]]";

const INTERNAL_CONTEXT_HEADER =
  [
    "Fased runtime context (internal):",
    "This context is runtime-generated, not user-authored. Keep internal details private.",
    "",
  ].join("\n") + "\n";

export function escapeInternalRuntimeContextDelimiters(value: string): string {
  return value
    .replaceAll(INTERNAL_RUNTIME_CONTEXT_BEGIN, ESCAPED_INTERNAL_RUNTIME_CONTEXT_BEGIN)
    .replaceAll(INTERNAL_RUNTIME_CONTEXT_END, ESCAPED_INTERNAL_RUNTIME_CONTEXT_END);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findDelimitedTokenIndex(text: string, token: string, from: number): number {
  const tokenRe = new RegExp(`(?:^|\\r?\\n)${escapeRegExp(token)}(?=\\r?\\n|$)`, "g");
  tokenRe.lastIndex = Math.max(0, from);
  const match = tokenRe.exec(text);
  if (!match) {
    return -1;
  }
  const prefixLength = match[0].length - token.length;
  return match.index + prefixLength;
}

function stripDelimitedBlock(text: string, begin: string, end: string): string {
  let next = text;
  for (;;) {
    const start = findDelimitedTokenIndex(next, begin, 0);
    if (start === -1) {
      return next;
    }

    let cursor = start + begin.length;
    let depth = 1;
    let finish = -1;
    while (depth > 0) {
      const nextBegin = findDelimitedTokenIndex(next, begin, cursor);
      const nextEnd = findDelimitedTokenIndex(next, end, cursor);
      if (nextEnd === -1) {
        break;
      }
      if (nextBegin !== -1 && nextBegin < nextEnd) {
        depth += 1;
        cursor = nextBegin + begin.length;
        continue;
      }
      depth -= 1;
      finish = nextEnd;
      cursor = nextEnd + end.length;
    }

    const before = next.slice(0, start).trimEnd();
    if (finish === -1 || depth !== 0) {
      return before;
    }
    const after = next.slice(finish + end.length).trimStart();
    next = before && after ? `${before}\n\n${after}` : `${before}${after}`;
  }
}

export function stripInternalRuntimeContext(text: string): string {
  if (!text) {
    return text;
  }
  return stripDelimitedBlock(text, INTERNAL_RUNTIME_CONTEXT_BEGIN, INTERNAL_RUNTIME_CONTEXT_END);
}

export function hasInternalRuntimeContext(text: string): boolean {
  if (!text) {
    return false;
  }
  return (
    findDelimitedTokenIndex(text, INTERNAL_RUNTIME_CONTEXT_BEGIN, 0) !== -1 ||
    text.includes(INTERNAL_CONTEXT_HEADER)
  );
}
