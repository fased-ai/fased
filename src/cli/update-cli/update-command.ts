import { defaultRuntime } from "../../runtime.js";
import type { UpdateCommandOptions } from "./shared.js";

const VERIFIED_INSTALLER =
  "curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh | bash";

export async function updateCommand(opts: UpdateCommandOptions = {}): Promise<void> {
  const message =
    "This Node/package runtime is not a managed update authority; rerun the verified public installer. Developers with a source checkout may use `fased dev update-source`.";
  if (opts.json) {
    defaultRuntime.log(
      JSON.stringify({
        status: "repair-required",
        reason: "verified-installer-required",
        message,
        installer: VERIFIED_INSTALLER,
      }),
    );
  } else {
    defaultRuntime.error(`${message}\nInstaller: ${VERIFIED_INSTALLER}`);
  }
  defaultRuntime.exit(1);
}
