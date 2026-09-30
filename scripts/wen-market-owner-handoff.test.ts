import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { expect, it } from "vitest";

const source = fs.readFileSync(new URL("./fased-signer-owner-hosting.sh", import.meta.url), "utf8");
// Exercise the launcher's real argument parser as an ordinary user. No host
// checks, staging, signer identity switch or administrative command is executed.
const dispatcher = source.slice(
  source.indexOf("ENROLLMENT=0"),
  source.indexOf("for executable in"),
);
const parser = source.slice(
  source.indexOf('args=("$@")'),
  source.indexOf('if [[ "$ENROLLMENT" == "1" ]]; then'),
);
function parse(args: string[]) {
  if (process.getuid?.() === 0) {
    throw new Error("Do not run this fixture as root");
  }
  return spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail\nusage() { :; }\n${dispatcher}\n${parser}\nprintf '%s\\n' "$ADMIN_DOMAIN" "$command_name" "\${args[@]}"`,
      "fixture",
      ...args,
    ],
    { encoding: "utf8" },
  );
}
const digest = `sha256:${"a".repeat(64)}`;
const admission = [
  "wen-market",
  "install-admission",
  "--wallet-id",
  "wallet-2",
  "--request-file",
  "/tmp/review.json",
  "--confirm-digest",
  digest,
];
it("forwards only the market command and wallet, stripping file-confirmation flags", () => {
  for (const action of ["install-draft", "install-admission"]) {
    const args = [...admission];
    args[1] = action;
    const result = parse(args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "wen-market",
      action,
      "--wallet-id",
      "wallet-2",
    ]);
  }
});
it("rejects socket overrides, signing commands, missing confirmation and unrelated flags", () => {
  for (const args of [
    ["wen-market", "execute", ...admission.slice(2)],
    admission.slice(0, 6),
    [...admission, "--control-socket", "/tmp/other"],
    [...admission, "--operator-socket=/tmp/other"],
    [...admission, "--policy-file", "/tmp/policy"],
    [...admission, "--output", "/tmp/out"],
    [...admission, "--request-file", "/tmp/other"],
    [...admission, "--sign"],
    ["wallet", "rotation-status", ...admission.slice(2)],
  ]) {
    const result = parse(args);
    expect(result.status, JSON.stringify(args)).not.toBe(0);
    expect(result.stdout).toBe("");
  }
});
it("binds staged bytes before passing them to the native receipt-checking CLI", () => {
  const stage = source.indexOf('staged_request="$work_dir/market-request.json"');
  const check = source.indexOf('[[ "sha256:$actual_request_digest" == "$confirm_digest" ]]');
  const invoke = source.indexOf('run_admin_command <"$staged_request"');
  expect(stage).toBeGreaterThan(0);
  expect(check).toBeGreaterThan(stage);
  expect(invoke).toBeGreaterThan(check);
  expect(source).toContain('"$request_mode" == "600"');
  expect(source).toContain('"$request_links" == "1"');
  expect(source).toContain('"$request_size" -le 16384');
  expect(source).toContain('[[ ! -e "$UPDATE_GATE" && ! -e "$UPDATE_JOURNAL" ]]');
});
