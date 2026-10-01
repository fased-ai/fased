import { afterEach, expect, it, vi } from "vitest";
import { satQuantityToAtoms } from "./wen-acquisition.js";
import type { WenAcquisitionPanel } from "./wen-acquisition.js";
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const reply = () => ({
  mode: "manual-owner-handoff",
  signingEnabled: false,
  url: "http://127.0.0.1:3004/#wen-request=test",
  request: { expiresAtMs: Date.now() + 60000 },
});
async function mount(request: ReturnType<typeof vi.fn>) {
  const panel = document.createElement("wen-acquisition-panel") as WenAcquisitionPanel;
  panel.client = { request: request as NonNullable<WenAcquisitionPanel["client"]>["request"] };
  panel.connected = true;
  panel.owner = "owner";
  panel.netAtoms = "100";
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}
it("prepares only on request and invalidates a link when the size changes", async () => {
  const request = vi.fn().mockResolvedValue(reply());
  const panel = await mount(request);
  expect(request).not.toHaveBeenCalled();
  panel.querySelector("button")!.click();
  await vi.waitFor(() => expect(panel.querySelector("a")).not.toBeNull());
  expect(request).toHaveBeenCalledExactlyOnceWith("wen.acquisition.handoff", {
    owner: "owner",
    action: "buy",
    netAtoms: "100",
  });
  panel.netAtoms = "200";
  await panel.updateComplete;
  expect(panel.querySelector("a")).toBeNull();
});
it.each([
  "https://example.com/#wen-request=test",
  "http://127.0.0.1:3004/?rpc=other#wen-request=test",
])("rejects an unexpected destination %s", async (url) => {
  const panel = await mount(vi.fn().mockResolvedValue({ ...reply(), url }));
  panel.querySelector("button")!.click();
  await vi.waitFor(() => expect(panel.error).toContain("unavailable"));
  expect(panel.querySelector("a")).toBeNull();
});
it("ignores a delayed response after disconnect", async () => {
  let resolve!: (value: unknown) => void;
  const panel = await mount(
    vi.fn().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    ),
  );
  panel.querySelector("button")!.click();
  panel.connected = false;
  await panel.updateComplete;
  resolve(reply());
  await new Promise((r) => setTimeout(r, 0));
  await panel.updateComplete;
  expect(panel.handoff).toBeNull();
  expect(panel.querySelector("a")).toBeNull();
});
it("blocks an expired link even without a render", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const panel = await mount(vi.fn().mockResolvedValue(reply()));
  panel.querySelector("button")!.click();
  await vi.waitFor(() => expect(panel.querySelector("a")).not.toBeNull());
  clock.mockReturnValue(now + 60001);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  panel.querySelector("a")!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await panel.updateComplete;
  expect(panel.querySelector("a")).toBeNull();
  expect(panel.error).toContain("expired");
});

it("converts retail SAT amounts exactly and rejects rounding or invalid quantities", () => {
  expect(satQuantityToAtoms("0.01")).toBe("1000000000");
  expect(satQuantityToAtoms("1.00000000001")).toBe("100000000001");
  for (const amount of ["0", "-1", "1e2", "0.000000000001", "184467440.73709551616"]) {
    expect(() => satQuantityToAtoms(amount)).toThrow();
  }
});
it("sends decimal input as exact base units without presenting raw atoms", async () => {
  const request = vi.fn().mockResolvedValue(reply());
  const panel = await mount(request);
  panel.quantity = "0.01";
  await panel.updateComplete;
  panel.querySelector("button")!.click();
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("wen.acquisition.handoff", {
      owner: "owner",
      action: "buy",
      netAtoms: "1000000000",
    }),
  );
  expect(panel.textContent).toContain("Amount (SAT)");
  expect(panel.textContent).not.toContain("base units");
});
