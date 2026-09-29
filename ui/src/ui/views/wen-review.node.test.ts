import { expect, it, vi } from "vitest";
import { reviewRows, WenReviewPanel } from "./wen-review.js";
const payload = () => ({
  ok: true,
  mode: "local-candidate-only",
  signingEnabled: false,
  payload: {
    signingEnabled: false,
    nextCursor: "",
    scanComplete: true,
    items: [
      {
        entry: "entry",
        status: "requires-review",
        reviewDraft: {
          descriptor: "e30=",
          review: {
            walletId: "miner",
            walletPublicKey: "owner",
            intent: {
              programId: "program",
              economy: "economy",
              operation: "sat",
              descriptorSha256: "a".repeat(64),
              capabilitySha256: "b".repeat(64),
              accountStateSha256: "c".repeat(64),
              genesis: "genesis",
              destination: "ata",
              id: "1",
              nonce: "1",
              ordinal: "0",
              minFinalizedSlot: "100",
              expectedGross: "20",
              minimumReceived: "19",
              maxFeeLamports: "5000",
              expiresSlot: "132",
            },
          },
        },
      },
    ],
  },
});
it("preserves exact units and rejects signed or malformed results", () => {
  expect(reviewRows(payload())[0]).toMatchObject({
    gross: "20",
    net: "19",
    fee: "5000",
    expires: "132",
  });
  expect(() => reviewRows({ ...payload(), signingEnabled: true })).toThrow();
  const broken = payload();
  broken.payload.items[0].reviewDraft.review.intent.expectedGross = "-1";
  expect(() => reviewRows(broken)).toThrow();
});
it("refreshes only unsigned reviews and discards late results for a replaced client", async () => {
  const panel = new WenReviewPanel();
  let finish!: (value: unknown) => void;
  const request = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  panel.client = { request } as never;
  panel.connected = true;
  const pending = panel.refresh();
  expect(request).toHaveBeenCalledWith("wen.mining.review.refresh", {});
  panel.client = { request: vi.fn() } as never;
  finish(payload());
  await pending;
  expect(panel.rows).toBeNull();
  panel.client = { request: vi.fn().mockResolvedValue(payload()) };
  await panel.refresh();
  expect(panel.rows?.[0].net).toBe("19");
});
it("follows validated cursors, rejects repeated cursors and resets the scan", async () => {
  const panel = new WenReviewPanel();
  panel.connected = true;
  const first = payload();
  first.payload.nextCursor = "admission.json";
  first.payload.scanComplete = false;
  const request = vi.fn().mockResolvedValue(first);
  panel.client = { request };
  await panel.refresh();
  expect(panel.rows?.[0]).toMatchObject({
    wallet: "miner",
    owner: "owner",
    program: "program",
    economy: "economy",
  });
  expect(panel.page).toBe(1);
  await panel.refresh(panel.nextCursor);
  expect(panel.rows).toBeNull();
  expect(panel.error).toContain("unavailable");
  request.mockResolvedValue(first);
  await panel.refresh();
  request.mockResolvedValue({ ...payload(), payload: { ...payload().payload, items: [] } });
  await panel.refresh(panel.nextCursor);
  expect(request).toHaveBeenLastCalledWith("wen.mining.review.refresh", {
    cursor: "admission.json",
  });
  expect(panel.page).toBe(2);
  expect(panel.rows).toEqual([]);
  expect(panel.nextCursor).toBe("");
  await panel.refresh();
  expect(panel.page).toBe(1);
});
it("exports the exact draft snapshot and enforces the signer input limit", () => {
  const input = payload();
  const draft = input.payload.items[0].reviewDraft;
  const exported = reviewRows(input)[0].draftJson;
  expect(JSON.parse(exported!)).toEqual(draft);
  draft.review.intent.minimumReceived = "0";
  expect(JSON.parse(exported!).review.intent.minimumReceived).toBe("19");
  draft.descriptor = "a".repeat(65536);
  expect(() => reviewRows(input)).toThrow("signer input limit");
});

it.each(["changed", "late", "ok"])("admitted claim response binding: %s", async (mode) => {
  const panel = new WenReviewPanel();
  const request = vi.fn().mockResolvedValue(payload());
  panel.client = { request };
  panel.connected = true;
  await panel.refresh();
  const row = panel.rows![0],
    base = JSON.parse(row.draftJson!).review.intent;
  panel.admissionHash = "d".repeat(64);
  let finish!: (value: unknown) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = panel.refreshAdmitted(row);
  if (mode === "late") {
    panel.connected = false;
  }
  finish({
    ok: true,
    mode: "local-candidate-only",
    signingEnabled: false,
    payload: {
      intent: {
        ...base,
        ...(mode === "changed" ? { minimumReceived: "0" } : {}),
        minFinalizedSlot: "101",
        expiresSlot: "133",
      },
      baseReviewSha256: "d".repeat(64),
      observedSlot: 102,
      signingEnabled: false,
    },
  });
  await pending;
  if (mode === "ok") {
    expect(panel.admitted?.observedSlot).toBe(102);
  } else {
    expect(panel.admitted).toBeNull();
  }
});
