import { clearScreenDown, cursorTo, emitKeypressEvents, moveCursor } from "node:readline";
import type { Option } from "@clack/prompts";
import { createCliProgress } from "../cli/progress.js";
import { stripAnsi } from "../terminal/ansi.js";
import { formatFramedBlock, note as emitNote } from "../terminal/note.js";
import { clearActiveProgressLine } from "../terminal/progress-line.js";
import {
  displayPromptMessage,
  formatWizardIntro,
  stylePromptHint,
  stylePromptTitle,
} from "../terminal/prompt-style.js";
import { theme } from "../terminal/theme.js";
import type { WizardProgress, WizardPrompter } from "./prompts.js";
import { WizardCancelledError } from "./prompts.js";

function normalizeSearchTokens(search: string): string[] {
  return search
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function buildOptionSearchText<T>(option: Option<T>): string {
  const label = stripAnsi(option.label ?? "");
  const hint = stripAnsi(option.hint ?? "");
  const value = String(option.value ?? "");
  return `${label} ${hint} ${value}`.toLowerCase();
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatChoiceLabel<T>(option: Option<T>): string {
  const label = option.label ?? String(option.value ?? "");
  if (option.disabled) {
    return theme.muted(label);
  }
  return label;
}

function radioMark(active: boolean): string {
  return active ? theme.success("●") : theme.noteChrome("○");
}

function multiMark(active: boolean, selected: boolean): string {
  if (selected && active) {
    return theme.success("◉");
  }
  if (selected) {
    return theme.success("✓");
  }
  return radioMark(active);
}

function trimLastChar(value: string): string {
  const chars = Array.from(value);
  chars.pop();
  return chars.join("");
}

function renderInputValue(
  value: string,
  params: { placeholder?: string; secret?: boolean },
): string {
  if (value.length > 0) {
    return params.secret ? theme.noteChrome("•".repeat(Array.from(value).length)) : value;
  }
  return params.placeholder ? theme.muted(params.placeholder) : "";
}

function renderPromptFrame(title: string, lines: string[]): string[] {
  return formatFramedBlock(lines, displayPromptMessage(title), { minWidth: 56 });
}

function writeStandaloneLine(value: string, options: { indent?: string } = {}): void {
  clearActiveProgressLine();
  const indent = options.indent ?? "";
  const output = value
    .split("\n")
    .map((line) => (line.length > 0 ? `${indent}${line}` : line))
    .join("\n");
  process.stdout.write(`${output}\n`);
}

function firstEnabledIndex<T>(options: Option<T>[]): number {
  return Math.max(
    0,
    options.findIndex((option) => !option.disabled),
  );
}

function moveSelection<T>(options: Option<T>[], current: number, delta: 1 | -1): number {
  if (options.length === 0) {
    return current;
  }
  let next = current;
  for (let i = 0; i < options.length; i += 1) {
    next = (next + delta + options.length) % options.length;
    if (!options[next]?.disabled) {
      return next;
    }
  }
  return current;
}

type Keypress = {
  ctrl?: boolean;
  name?: string;
  sequence?: string;
};

async function chooseWithArrows<T>(params: {
  message: string;
  options: Option<T>[];
  initialValue?: T;
}): Promise<T> {
  if (params.options.length === 0) {
    throw new WizardCancelledError("No options available.");
  }
  const fallbackIndex = firstEnabledIndex(params.options);
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    return params.options[fallbackIndex].value;
  }
  const initialIndex = params.options.findIndex((opt) => opt.value === params.initialValue);
  let activeIndex =
    initialIndex >= 0 && !params.options[initialIndex]?.disabled ? initialIndex : fallbackIndex;
  let renderedLines = 0;

  return await new Promise<T>((resolve, reject) => {
    const render = () => {
      if (renderedLines > 0) {
        moveCursor(process.stdout, 0, -renderedLines);
        cursorTo(process.stdout, 0);
        clearScreenDown(process.stdout);
      }
      const lines = renderPromptFrame(
        params.message,
        params.options.map(
          (option, index) => `  ${radioMark(index === activeIndex)} ${formatChoiceLabel(option)}`,
        ),
      );
      process.stdout.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    };
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onKeypress = (_value: string, key: Keypress = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new WizardCancelledError());
        return;
      }
      if (key.name === "up" || key.sequence === "\u001B[A") {
        activeIndex = moveSelection(params.options, activeIndex, -1);
        render();
        return;
      }
      if (key.name === "down" || key.sequence === "\u001B[B") {
        activeIndex = moveSelection(params.options, activeIndex, 1);
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(params.options[activeIndex].value);
      }
    };
    process.stdout.write("\n");
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
    render();
  });
}

async function chooseMultiWithArrows<T>(params: {
  message: string;
  options: Option<T>[];
  initialValues?: T[];
}): Promise<T[]> {
  if (params.options.length === 0) {
    return [];
  }
  const initialSet = new Set(params.initialValues ?? []);
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    return params.options
      .filter((option) => initialSet.has(option.value) && !option.disabled)
      .map((option) => option.value);
  }
  let activeIndex = firstEnabledIndex(params.options);
  let renderedLines = 0;
  const selectedIndexes = new Set<number>();
  params.options.forEach((option, index) => {
    if (initialSet.has(option.value) && !option.disabled) {
      selectedIndexes.add(index);
    }
  });

  return await new Promise<T[]>((resolve, reject) => {
    const render = () => {
      if (renderedLines > 0) {
        moveCursor(process.stdout, 0, -renderedLines);
        cursorTo(process.stdout, 0);
        clearScreenDown(process.stdout);
      }
      const lines = renderPromptFrame(
        params.message,
        params.options.map((option, index) => {
          const selected = selectedIndexes.has(index);
          return `  ${multiMark(index === activeIndex, selected)} ${formatChoiceLabel(option)}`;
        }),
      );
      process.stdout.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    };
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onKeypress = (_value: string, key: Keypress = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new WizardCancelledError());
        return;
      }
      if (key.name === "up" || key.sequence === "\u001B[A") {
        activeIndex = moveSelection(params.options, activeIndex, -1);
        render();
        return;
      }
      if (key.name === "down" || key.sequence === "\u001B[B") {
        activeIndex = moveSelection(params.options, activeIndex, 1);
        render();
        return;
      }
      if (key.name === "space" || key.sequence === " ") {
        if (!params.options[activeIndex]?.disabled) {
          if (selectedIndexes.has(activeIndex)) {
            selectedIndexes.delete(activeIndex);
          } else {
            selectedIndexes.add(activeIndex);
          }
          render();
        }
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(
          Array.from(selectedIndexes)
            .toSorted((a, b) => a - b)
            .map((index) => params.options[index].value),
        );
      }
    };
    process.stdout.write("\n");
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
    render();
  });
}

async function confirmWithArrows(params: {
  message: string;
  initialValue?: boolean;
}): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    return params.initialValue ?? true;
  }
  let activeValue = params.initialValue ?? true;
  let renderedLines = 0;

  return await new Promise<boolean>((resolve, reject) => {
    const render = () => {
      if (renderedLines > 0) {
        moveCursor(process.stdout, 0, -renderedLines);
        cursorTo(process.stdout, 0);
        clearScreenDown(process.stdout);
      }
      const lines = renderPromptFrame(params.message, [
        `  ${radioMark(activeValue)} Yes   ${radioMark(!activeValue)} No`,
      ]);
      process.stdout.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    };
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onKeypress = (_value: string, key: Keypress = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new WizardCancelledError());
        return;
      }
      if (
        key.name === "up" ||
        key.name === "down" ||
        key.name === "left" ||
        key.name === "right" ||
        key.sequence === "\u001B[A" ||
        key.sequence === "\u001B[B" ||
        key.sequence === "\u001B[D" ||
        key.sequence === "\u001B[C"
      ) {
        activeValue = !activeValue;
        render();
        return;
      }
      if (key.name === "y" || key.sequence?.toLowerCase() === "y") {
        cleanup();
        resolve(true);
        return;
      }
      if (key.name === "n" || key.sequence?.toLowerCase() === "n") {
        cleanup();
        resolve(false);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(activeValue);
      }
    };
    process.stdout.write("\n");
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
    render();
  });
}

async function textWithFrame(params: {
  message: string;
  initialValue?: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
  secret?: boolean;
}): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    const value = params.initialValue ?? "";
    const error = params.validate?.(value);
    if (error) {
      throw new WizardCancelledError(error);
    }
    return value;
  }

  let value = params.initialValue ?? "";
  let error: string | undefined;
  let renderedLines = 0;

  return await new Promise<string>((resolve, reject) => {
    const render = () => {
      if (renderedLines > 0) {
        moveCursor(process.stdout, 0, -renderedLines);
        cursorTo(process.stdout, 0);
        clearScreenDown(process.stdout);
      }
      const input = renderInputValue(value, {
        placeholder: params.placeholder,
        secret: params.secret,
      });
      const lines = renderPromptFrame(params.message, [
        `  ${theme.noteChrome(">")} ${input}`,
        ...(error ? [`  ${theme.error(error)}`] : []),
      ]);
      process.stdout.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    };
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const appendPrintable = (sequence: string) => {
      for (const char of Array.from(sequence)) {
        if (char >= " " && char !== "\x7f") {
          value += char;
        }
      }
    };
    const onKeypress = (input: string, key: Keypress = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new WizardCancelledError());
        return;
      }
      if (key.ctrl && key.name === "u") {
        value = "";
        error = undefined;
        render();
        return;
      }
      if (key.name === "backspace" || key.sequence === "\x7f") {
        value = trimLastChar(value);
        error = undefined;
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const validationError = params.validate?.(value);
        if (validationError) {
          error = validationError;
          render();
          return;
        }
        cleanup();
        resolve(value);
        return;
      }
      const sequence = key.sequence ?? input;
      if (!key.ctrl && sequence) {
        appendPrintable(sequence);
        error = undefined;
        render();
      }
    };

    process.stdout.write("\n");
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
    render();
  });
}

export function tokenizedOptionFilter<T>(search: string, option: Option<T>): boolean {
  const tokens = normalizeSearchTokens(search);
  if (tokens.length === 0) {
    return true;
  }
  const haystack = buildOptionSearchText(option);
  return tokens.every((token) => haystack.includes(token));
}

export function createClackPrompter(): WizardPrompter {
  return {
    intro: async (title) => {
      writeStandaloneLine(formatWizardIntro(title));
    },
    outro: async (message) => {
      writeStandaloneLine(stylePromptTitle(message) ?? message, { indent: "  " });
    },
    note: async (message, title) => {
      emitNote(message, title);
    },
    select: async (params) =>
      chooseWithArrows({
        message: params.message,
        options: params.options.map((opt) => {
          const base = { value: opt.value, label: opt.label, disabled: opt.disabled };
          return opt.hint === undefined ? base : { ...base, hint: stylePromptHint(opt.hint) };
        }) as Option<(typeof params.options)[number]["value"]>[],
        initialValue: params.initialValue,
      }),
    multiselect: async (params) => {
      const options = params.options.map((opt) => {
        const base = { value: opt.value, label: opt.label, disabled: opt.disabled };
        return opt.hint === undefined ? base : { ...base, hint: stylePromptHint(opt.hint) };
      }) as Option<(typeof params.options)[number]["value"]>[];

      return chooseMultiWithArrows({
        message: params.message,
        options,
        initialValues: params.initialValues,
      });
    },
    text: async (params) => textWithFrame(params),
    secret: async (params) => textWithFrame({ ...params, secret: true }),
    confirm: async (params) =>
      confirmWithArrows({
        message: params.message,
        initialValue: params.initialValue,
      }),
    progress: (label: string): WizardProgress => {
      const startedAt = Date.now();
      let currentMessage = label;
      const render = (message: string) =>
        `${message} ${theme.muted(`(${formatElapsed(Date.now() - startedAt)})`)}`;
      const elapsedTimer = setInterval(() => {
        osc.setLabel(render(currentMessage));
      }, 1_000);
      elapsedTimer.unref?.();
      const osc = createCliProgress({
        label: render(currentMessage),
        indeterminate: true,
        enabled: true,
        fallback: "line",
        stream: process.stdout,
      });
      return {
        update: (message) => {
          currentMessage = message;
          osc.setLabel(render(currentMessage));
        },
        stop: (message) => {
          void message;
          clearInterval(elapsedTimer);
          osc.done();
        },
      };
    },
  };
}
