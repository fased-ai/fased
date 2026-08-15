import { defaultRuntime } from "../../runtime.js";
import type { UpdateStatusOptions } from "./shared.js";

const VERIFIED_INSTALLER =
  "curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh | bash";

export async function updateStatusCommand(opts: UpdateStatusOptions): Promise<void> {
  const message =
    "This Node/package runtime is not the managed lifecycle status authority; run `fased update status` through the installed launcher or repair it with the verified public installer.";
  if (opts.json) {
    defaultRuntime.log(
      JSON.stringify({
        status: "repair-required",
        reason: "managed-launcher-required",
        message,
        installer: VERIFIED_INSTALLER,
      }),
    );
  } else {
    defaultRuntime.error(`${message}\nInstaller: ${VERIFIED_INSTALLER}`);
  }
  defaultRuntime.exit(1);
}
