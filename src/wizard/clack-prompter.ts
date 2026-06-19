import {
  autocompleteMultiselect,
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  type Option,
  outro,
  password,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { createCliProgress } from "../cli/progress.js";
import { stripAnsi } from "../terminal/ansi.js";
import { note as emitNote } from "../terminal/note.js";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";
import { theme } from "../terminal/theme.js";
import type { WizardProgress, WizardPrompter } from "./prompts.js";
import { WizardCancelledError } from "./prompts.js";

function guardCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel(stylePromptTitle("Setup cancelled.") ?? "Setup cancelled.");
    throw new WizardCancelledError();
  }
  return value;
}

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
      intro(stylePromptTitle(title) ?? title);
    },
    outro: async (message) => {
      outro(stylePromptTitle(message) ?? message);
    },
    note: async (message, title) => {
      emitNote(message, title);
    },
    select: async (params) =>
      guardCancel(
        await select({
          message: stylePromptMessage(params.message),
          options: params.options.map((opt) => {
            const base = { value: opt.value, label: opt.label, disabled: opt.disabled };
            return opt.hint === undefined ? base : { ...base, hint: stylePromptHint(opt.hint) };
          }) as Option<(typeof params.options)[number]["value"]>[],
          initialValue: params.initialValue,
        }),
      ),
    multiselect: async (params) => {
      const options = params.options.map((opt) => {
        const base = { value: opt.value, label: opt.label, disabled: opt.disabled };
        return opt.hint === undefined ? base : { ...base, hint: stylePromptHint(opt.hint) };
      }) as Option<(typeof params.options)[number]["value"]>[];

      if (params.searchable) {
        return guardCancel(
          await autocompleteMultiselect({
            message: stylePromptMessage(params.message),
            options,
            initialValues: params.initialValues,
            filter: tokenizedOptionFilter,
          }),
        );
      }

      return guardCancel(
        await multiselect({
          message: stylePromptMessage(params.message),
          options,
          initialValues: params.initialValues,
        }),
      );
    },
    text: async (params) => {
      const validate = params.validate;
      return guardCancel(
        await text({
          message: stylePromptMessage(params.message),
          initialValue: params.initialValue,
          placeholder: params.placeholder,
          validate: validate ? (value) => validate(value ?? "") : undefined,
        }),
      );
    },
    secret: async (params) => {
      const validate = params.validate;
      return guardCancel(
        await password({
          message: stylePromptMessage(params.message),
          validate: validate ? (value) => validate(value ?? "") : undefined,
          mask: "•",
        }),
      );
    },
    confirm: async (params) =>
      guardCancel(
        await confirm({
          message: stylePromptMessage(params.message),
          initialValue: params.initialValue,
        }),
      ),
    progress: (label: string): WizardProgress => {
      const spin = spinner();
      const startedAt = Date.now();
      let currentMessage = label;
      const render = (message: string) =>
        `${theme.accent(message)} ${theme.muted(`(${formatElapsed(Date.now() - startedAt)})`)}`;
      spin.start(render(currentMessage));
      const elapsedTimer = setInterval(() => {
        spin.message(render(currentMessage));
      }, 1_000);
      elapsedTimer.unref?.();
      const osc = createCliProgress({
        label,
        indeterminate: true,
        enabled: true,
        fallback: "none",
      });
      return {
        update: (message) => {
          currentMessage = message;
          spin.message(render(currentMessage));
          osc.setLabel(message);
        },
        stop: (message) => {
          clearInterval(elapsedTimer);
          osc.done();
          if (message && message.trim().length > 0) {
            spin.stop(theme.success(message));
          } else {
            spin.clear();
          }
        },
      };
    },
  };
}
