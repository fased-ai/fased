import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { loginAnthropic } from "@mariozechner/pi-ai/oauth";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";

export async function loginAnthropicOAuth(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  localBrowserMessage?: string;
}): Promise<OAuthCredentials | null> {
  const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;

  await prompter.note(
    isRemote
      ? [
          "You are running in a remote/VPS environment.",
          "A URL will be shown for you to open in your LOCAL browser.",
          "After signing in, paste the Anthropic authorization code back here.",
        ].join("\n")
      : [
          "Browser will open for Anthropic authentication.",
          "After signing in, paste the Anthropic authorization code if asked.",
        ].join("\n"),
    "Anthropic OAuth",
  );

  const spin = prompter.progress("Starting Anthropic OAuth flow...");
  try {
    const { onAuth, onPrompt } = createVpsAwareOAuthHandlers({
      isRemote,
      prompter,
      runtime,
      spin,
      openUrl,
      localBrowserMessage: localBrowserMessage ?? "Complete Anthropic sign-in in browser...",
      manualPromptMessage: "Paste the Anthropic authorization code shown after sign-in",
    });

    let authUrlHandled = Promise.resolve();
    const creds = await loginAnthropic(
      (url) => {
        authUrlHandled = onAuth({ url });
      },
      async () => {
        await authUrlHandled;
        return await onPrompt({
          message: "Paste the Anthropic authorization code",
          placeholder: "code#state",
        });
      },
    );
    await authUrlHandled;
    spin.stop("Anthropic OAuth complete");
    return creds ?? null;
  } catch (err) {
    spin.stop("Anthropic OAuth failed");
    runtime.error(String(err));
    await prompter.note(
      "Trouble with OAuth? Retry sign-in or use Anthropic setup-token/API key.",
      "OAuth help",
    );
    throw err;
  }
}
