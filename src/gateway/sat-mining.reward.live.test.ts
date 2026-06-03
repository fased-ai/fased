import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";

const execFileAsync = promisify(execFile);
const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.FASED_LIVE_TEST);
const SAT_LIVE = isTruthyEnvValue(process.env.FASED_LIVE_SAT_MINING);
const SAT_REWARD_LIVE = isTruthyEnvValue(process.env.FASED_LIVE_SAT_MINING_REWARD);
const describeLive = LIVE && SAT_LIVE && SAT_REWARD_LIVE ? describe : describe.skip;

function parseU64Line(stdout: string, label: string): bigint {
  const match = stdout.match(new RegExp(`${label}=(\\d+)`));
  if (!match) {
    throw new Error(`Missing ${label} in output`);
  }
  return BigInt(match[1]);
}

function parseTxLine(stdout: string, label: string): string {
  const match = stdout.match(new RegExp(`${label} ([1-9A-HJ-NP-Za-km-z]+)`));
  if (!match) {
    throw new Error(`Missing ${label} tx in output`);
  }
  return match[1];
}

function requireLiveEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for FASED_LIVE_SAT_MINING_REWARD`);
  }
  return value;
}

async function runRewardExample(params: {
  satRepoPath: string;
  rpcUrl: string;
  minerKeypair: string;
}): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "cargo",
      ["run", "-p", "sat-cli", "--example", "devnet_payout_claim"],
      {
        cwd: params.satRepoPath,
        env: {
          ...process.env,
          RPC_URL: params.rpcUrl,
          MINER_KEYPAIR: params.minerKeypair,
        },
        timeout: 240_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `${value.message ?? "reward example failed"}\n${value.stdout ?? ""}\n${value.stderr ?? ""}`,
      { cause: error },
    );
  }
}

describeLive("sat mining reward live", () => {
  it("proves SAT reward path with real claim progression", async () => {
    const satRepoPath = requireLiveEnv("FASED_LIVE_SAT_REPO");
    const rpcUrl = requireLiveEnv("FASED_LIVE_SAT_RPC_URL");
    const minerKeypair = requireLiveEnv("FASED_LIVE_SAT_MINER_KEYPAIR");

    const combined = await runRewardExample({ satRepoPath, rpcUrl, minerKeypair });
    const recipientBefore = parseU64Line(combined, "recipient_before");
    const recipientAfter = parseU64Line(combined, "recipient_after");
    const treasuryBefore = parseU64Line(combined, "treasury_before");
    const treasuryAfter = parseU64Line(combined, "treasury_after");
    const claimTx = parseTxLine(combined, "claim");

    expect(parseTxLine(combined, "init").length).toBeGreaterThan(20);
    expect(parseTxLine(combined, "heartbeat").length).toBeGreaterThan(20);
    expect(parseTxLine(combined, "commit").length).toBeGreaterThan(20);
    expect(parseTxLine(combined, "reveal").length).toBeGreaterThan(20);
    expect(parseTxLine(combined, "finalize_round").length).toBeGreaterThan(20);
    expect(parseTxLine(combined, "finalize_epoch").length).toBeGreaterThan(20);
    expect(parseTxLine(combined, "mining_crank").length).toBeGreaterThan(20);
    expect(claimTx.length).toBeGreaterThan(20);

    expect(recipientAfter).toBeGreaterThan(recipientBefore);
    expect(treasuryAfter).toBeLessThan(treasuryBefore);
  }, 300_000);
});
