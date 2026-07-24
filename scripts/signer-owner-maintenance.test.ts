import fs from "node:fs";
import { describe, expect, it } from "vitest";

const launcher = fs.readFileSync(
  new URL("./fased-signer-owner-hosting.sh", import.meta.url),
  "utf8",
);
const installer = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf8");

describe("Hosting signer-owner maintenance launcher", () => {
  it("keeps custody-changing commands behind one bounded signer-owner ceremony", () => {
    expect(launcher).toContain('if [[ "${EUID}" != "0" ]]');
    expect(launcher).toContain(
      'CONTROL_SOCKET="${FASED_SIGNER_CONTROL_SOCKET:-/run/fased-signerd/control.sock}"',
    );
    expect(launcher).toContain('"$RUNUSER_BIN" -u "$SIGNER_USER"');
    expect(launcher).toContain("--control-socket");
    expect(launcher).toContain("recovery-export|recovery-import|export-raw");
    expect(launcher).toContain("rotate-successor|rotation-status|rotation-commit");
    expect(launcher).toContain('[[ ! -e "$UPDATE_GATE" && ! -e "$UPDATE_JOURNAL" ]]');
    expect(launcher).toContain(
      "--control-socket|--control-socket=*|--operator-socket|--operator-socket=*",
    );
    expect(launcher).not.toMatch(/\beval\b/u);
    expect(launcher).not.toMatch(/sudoers/u);
  });

  it("is installed only from the verified root Hosting bundle", () => {
    expect(installer).toContain(
      "scripts/fased-signer-owner-hosting.sh \\\n    scripts/fased-signer-policy-hosting.sh",
    );
    expect(installer).toContain(
      '"$FASED_DIR/scripts/fased-signer-owner-hosting.sh" /usr/local/sbin/fased-signer-owner',
    );
    expect(installer).toContain("sync -f /usr/local/sbin/fased-signer-owner");
  });
});
