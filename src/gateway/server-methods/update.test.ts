import { describe, expect, it, vi } from "vitest";

vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

describe("Gateway update boundary", () => {
  it("refuses update.status so the owner-shell Go manifest remains canonical", async () => {
    const respond = vi.fn();
    const { updateHandlers } = await import("./update.js");

    await updateHandlers["update.status"]({ params: {}, respond } as never);

    const [ok, payload, error] = respond.mock.calls[0] ?? [];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({ code: "UNAVAILABLE" });
    expect(error?.message).toContain("fased update status from the owner shell");
  });

  it("refuses update.run and points to the owner-shell Go lifecycle", async () => {
    const respond = vi.fn();
    const { updateHandlers } = await import("./update.js");

    await updateHandlers["update.run"]({ params: {}, respond } as never);

    expect(respond).toHaveBeenCalledOnce();
    const [ok, payload, error] = respond.mock.calls[0] ?? [];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({ code: "UNAVAILABLE" });
    expect(error?.message).toContain("run fased update from the owner shell");
  });
});
