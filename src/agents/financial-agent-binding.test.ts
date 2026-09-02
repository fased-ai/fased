import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachFinancialAgentFromFinalizedReadback,
  detachFinancialAgentWorkspace,
  financialAgentReattachmentMessage,
  findFinancialAgentBindingForLocalAgent,
  issueFinancialAgentReattachmentChallenge,
  listFinancialAgentBindings,
  type FinalizedFinancialAgentReadback,
} from "./financial-agent-binding.js";

const temporaryRoots: string[] = [];

function testEnv(): NodeJS.ProcessEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-financial-agent-"));
  temporaryRoots.push(root);
  return { ...process.env, FASED_STATE_DIR: root };
}

function signer() {
  const keys = generateKeyPairSync("ed25519");
  const der = keys.publicKey.export({ type: "spki", format: "der" });
  return {
    address: new PublicKey(der.subarray(der.length - 32)).toBase58(),
    sign(message: string) {
      return sign(null, Buffer.from(message, "utf8"), keys.privateKey).toString("base64");
    },
  };
}

function address(): string {
  return Keypair.generate().publicKey.toBase58();
}

function readback(controller: string, recoveryAuthority: string): FinalizedFinancialAgentReadback {
  return {
    programId: "FasEdZ9BAsboUPF2TUQjLaapC8arcAkV5fRnMtV2G1Ev", // pragma: allowlist secret
    genesisHash: address(),
    fasedAgentRecord: address(),
    status: "active",
    controller,
    recoveryAuthority,
    authorityGeneration: "3",
    createdSlot: "40",
    createdUnixTimestamp: "1788350400",
    finalizedSlot: 42,
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("financial Agent binding", () => {
  it("attaches from finalized state only after a current controller signature", () => {
    const env = testEnv();
    const controller = signer();
    const recovery = signer();
    const finalized = readback(controller.address, recovery.address);
    const challenge = issueFinancialAgentReattachmentChallenge({
      fasedAgentRecord: finalized.fasedAgentRecord,
      localAgentId: "wally",
      authorityGeneration: finalized.authorityGeneration,
      env,
    });

    const binding = attachFinancialAgentFromFinalizedReadback({
      readback: finalized,
      challenge,
      signer: controller.address,
      signatureBase64: controller.sign(financialAgentReattachmentMessage(challenge)),
      env,
    });

    expect(binding.attachments).toEqual([
      expect.objectContaining({ localAgentId: "wally", state: "attached" }),
    ]);
    expect(findFinancialAgentBindingForLocalAgent("wally", env)?.fasedAgentRecord).toBe(
      finalized.fasedAgentRecord,
    );
  });

  it("supports clean-install reattachment by the finalized recovery authority", () => {
    const env = testEnv();
    const controller = signer();
    const recovery = signer();
    const finalized = readback(controller.address, recovery.address);
    const challenge = issueFinancialAgentReattachmentChallenge({
      fasedAgentRecord: finalized.fasedAgentRecord,
      localAgentId: "restored-agent",
      authorityGeneration: "3",
      env,
    });

    attachFinancialAgentFromFinalizedReadback({
      readback: finalized,
      challenge,
      signer: recovery.address,
      signatureBase64: recovery.sign(financialAgentReattachmentMessage(challenge)),
      env,
    });

    expect(listFinancialAgentBindings(env)).toHaveLength(1);
  });

  it("turns local deletion into a durable detach tombstone", () => {
    const env = testEnv();
    const controller = signer();
    const recovery = signer();
    const finalized = readback(controller.address, recovery.address);
    const challenge = issueFinancialAgentReattachmentChallenge({
      fasedAgentRecord: finalized.fasedAgentRecord,
      localAgentId: "wally",
      authorityGeneration: "3",
      env,
    });
    attachFinancialAgentFromFinalizedReadback({
      readback: finalized,
      challenge,
      signer: controller.address,
      signatureBase64: controller.sign(financialAgentReattachmentMessage(challenge)),
      env,
    });

    expect(detachFinancialAgentWorkspace({ localAgentId: "wally", env })).toEqual({
      detached: true,
      fasedAgentRecord: finalized.fasedAgentRecord,
    });
    expect(findFinancialAgentBindingForLocalAgent("wally", env)).toBeNull();
    expect(listFinancialAgentBindings(env)[0]?.attachments[0]).toEqual(
      expect.objectContaining({ localAgentId: "wally", state: "detached" }),
    );
  });

  it("rejects stale generations, unissued challenges, wrong signers, and replay", () => {
    const env = testEnv();
    const controller = signer();
    const recovery = signer();
    const stranger = signer();
    const finalized = readback(controller.address, recovery.address);
    const stale = issueFinancialAgentReattachmentChallenge({
      fasedAgentRecord: finalized.fasedAgentRecord,
      localAgentId: "wally",
      authorityGeneration: "2",
      env,
    });
    expect(() =>
      attachFinancialAgentFromFinalizedReadback({
        readback: finalized,
        challenge: stale,
        signer: controller.address,
        signatureBase64: controller.sign(financialAgentReattachmentMessage(stale)),
        env,
      }),
    ).toThrow("does not match finalized Agent state");

    const challenge = issueFinancialAgentReattachmentChallenge({
      fasedAgentRecord: finalized.fasedAgentRecord,
      localAgentId: "wally",
      authorityGeneration: "3",
      env,
    });
    expect(() =>
      attachFinancialAgentFromFinalizedReadback({
        readback: finalized,
        challenge,
        signer: stranger.address,
        signatureBase64: stranger.sign(financialAgentReattachmentMessage(challenge)),
        env,
      }),
    ).toThrow("not the finalized controller or recovery authority");

    const signatureBase64 = controller.sign(financialAgentReattachmentMessage(challenge));
    attachFinancialAgentFromFinalizedReadback({
      readback: finalized,
      challenge,
      signer: controller.address,
      signatureBase64,
      env,
    });
    expect(() =>
      attachFinancialAgentFromFinalizedReadback({
        readback: finalized,
        challenge,
        signer: controller.address,
        signatureBase64,
        env,
      }),
    ).toThrow(/not issued|consumed/u);
  });
});
