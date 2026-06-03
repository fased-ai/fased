import { redactSensitiveText } from "../logging/redact.js";
import { redactSensitiveUrlLikeString } from "../shared/net/redact-sensitive-url.js";

export function redactWalletDiagnosticText(value: string): string {
  return redactSensitiveText(redactSensitiveUrlLikeString(value), { mode: "tools" });
}

export function walletDiagnosticErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactWalletDiagnosticText(message);
}

export function walletDiagnosticErrorString(error: unknown): string {
  return redactWalletDiagnosticText(String(error));
}
