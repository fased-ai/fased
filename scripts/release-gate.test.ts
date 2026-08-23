import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReleaseGateReceipt,
  digestValue,
  parseReleaseGateReceipt,
  readReleaseGateReceipt,
} from "./release-gate.mjs";

const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const treeA = "c".repeat(40);
const treeB = "d".repeat(40);
const lockfileDigest = `sha256:${"1".repeat(64)}`;
const descriptorDigest = `sha256:${"2".repeat(64)}`;
const artifactSetDigest = `sha256:${"3".repeat(64)}`;
const hostingStagingReceiptDigest = `sha256:${"5".repeat(64)}`;

function source(commit = commitA, tree = treeA) {
  return { commit, tree, lockfileDigest };
}

function release() {
  return { version: "0.1.76-rc.103", tag: "v0.1.76-rc.103" };
}

function claims(phase: string) {
  if (phase === "pre-candidate") {
    return {
      hostingStagingReceiptDigest,
      mainChecksJobId: "1002",
      mainRunId: "1001",
      managedPredecessorVersion: "0.1.60",
      predecessorVersion: "0.1.75",
      releaseSequence: "103",
      securityEpoch: "1",
      workflowRunId: "1003",
    };
  }
  if (phase === "pre-tag-p1") {
    return {
      hostingStagingReceiptDigest,
      managedPredecessorVersion: "0.1.60",
      preCandidateRunId: "1003",
      predecessorVersion: "0.1.75",
      releaseSequence: "103",
      securityEpoch: "1",
      workflowRunId: "1004",
    };
  }
  if (phase === "candidate-finalization") {
    return { preCandidateRunId: "1003", preTagP1RunId: "1004", workflowRunId: "1005" };
  }
  return { publicationRunId: "1006", sourceRunId: "1005", workflowRunId: "1006" };
}

function artifact() {
  return { descriptorDigest, artifactSetDigest };
}

describe("release gate receipt", () => {
  it("binds the complete release chain and content-addressed cache identity", () => {
    const preCandidate = buildReleaseGateReceipt({
      phase: "pre-candidate",
      source: source(),
      release: release(),
      artifact: null,
      claims: claims("pre-candidate"),
      upstream: null,
    });
    const preTag = buildReleaseGateReceipt({
      phase: "pre-tag-p1",
      source: source(commitB, treeB),
      release: release(),
      artifact: artifact(),
      claims: claims("pre-tag-p1"),
      upstream: preCandidate,
    });
    const finalization = buildReleaseGateReceipt({
      phase: "candidate-finalization",
      source: source(commitB, treeB),
      release: release(),
      artifact: artifact(),
      claims: claims("candidate-finalization"),
      upstream: preTag,
    });
    const publication = buildReleaseGateReceipt({
      phase: "candidate-publication",
      source: source(commitB, treeB),
      release: release(),
      artifact: artifact(),
      claims: claims("candidate-publication"),
      upstream: finalization,
    });

    expect(publication.upstream).toMatchObject({
      phase: "candidate-finalization",
      receiptDigest: finalization.receiptDigest,
      artifactSetDigest,
    });
    expect(publication.cacheKey).toBe(finalization.cacheKey);
    expect(publication.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("rejects a candidate byte change after finalization", () => {
    const preCandidate = buildReleaseGateReceipt({
      phase: "pre-candidate",
      source: source(),
      release: release(),
      artifact: null,
      claims: claims("pre-candidate"),
      upstream: null,
    });
    const preTag = buildReleaseGateReceipt({
      phase: "pre-tag-p1",
      source: source(commitB, treeB),
      release: release(),
      artifact: artifact(),
      claims: claims("pre-tag-p1"),
      upstream: preCandidate,
    });
    const finalization = buildReleaseGateReceipt({
      phase: "candidate-finalization",
      source: source(commitB, treeB),
      release: release(),
      artifact: artifact(),
      claims: claims("candidate-finalization"),
      upstream: preTag,
    });

    expect(() =>
      buildReleaseGateReceipt({
        phase: "candidate-publication",
        source: source(commitB, treeB),
        release: release(),
        artifact: { descriptorDigest, artifactSetDigest: `sha256:${"5".repeat(64)}` },
        claims: claims("candidate-publication"),
        upstream: finalization,
      }),
    ).toThrow("candidate bytes changed after finalization");
  });

  it("rejects a broken upstream workflow identity", () => {
    const preCandidate = buildReleaseGateReceipt({
      phase: "pre-candidate",
      source: source(),
      release: release(),
      artifact: null,
      claims: claims("pre-candidate"),
      upstream: null,
    });
    expect(() =>
      buildReleaseGateReceipt({
        phase: "pre-tag-p1",
        source: source(commitB, treeB),
        release: release(),
        artifact: artifact(),
        claims: { ...claims("pre-tag-p1"), preCandidateRunId: "9999" },
        upstream: preCandidate,
      }),
    ).toThrow("pre-candidate workflow identity changed across the pre-tag gate");
  });

  it("rejects tampered receipts and incomplete phase claims", () => {
    const receipt = buildReleaseGateReceipt({
      phase: "pre-candidate",
      source: source(),
      release: release(),
      artifact: null,
      claims: claims("pre-candidate"),
      upstream: null,
    });
    expect(() =>
      parseReleaseGateReceipt({ ...receipt, cacheKey: `sha256:${"4".repeat(64)}` }),
    ).toThrow("content-addressed cache key mismatch");
    const incomplete = { ...claims("pre-candidate") };
    delete incomplete.mainRunId;
    expect(() =>
      buildReleaseGateReceipt({
        phase: "pre-candidate",
        source: source(),
        release: release(),
        artifact: null,
        claims: incomplete,
        upstream: null,
      }),
    ).toThrow("pre-candidate claims are incomplete");
  });

  it("produces deterministic receipts independent of claim insertion order", async () => {
    const ordered = claims("pre-candidate");
    const reversed = Object.fromEntries(Object.entries(ordered).toReversed());
    const left = buildReleaseGateReceipt({
      phase: "pre-candidate",
      source: source(),
      release: release(),
      artifact: null,
      claims: ordered,
      upstream: null,
    });
    const right = buildReleaseGateReceipt({
      phase: "pre-candidate",
      source: source(),
      release: release(),
      artifact: null,
      claims: reversed,
      upstream: null,
    });
    expect(right).toEqual(left);

    const temporary = await mkdtemp(path.join(os.tmpdir(), "fased-release-gate-test."));
    const receiptPath = path.join(temporary, "receipt.json");
    await writeFile(receiptPath, `${JSON.stringify(left)}\n`);
    expect(digestValue(await readFile(receiptPath))).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("reads only a canonical regular receipt and rejects a symlink upstream", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "fased-release-gate-cli."));
    const output = path.join(temporary, "pre-candidate.json");
    const receipt = buildReleaseGateReceipt({
      phase: "pre-candidate",
      source: source(),
      release: release(),
      artifact: null,
      claims: claims("pre-candidate"),
      upstream: null,
    });
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(readReleaseGateReceipt(output)).toEqual(receipt);

    const links = path.join(temporary, "links");
    await mkdir(links);
    const linked = path.join(links, "receipt.json");
    await symlink(output, linked);
    expect(() => readReleaseGateReceipt(linked)).toThrow(
      "must be one bounded regular single-link file",
    );
  });
});
