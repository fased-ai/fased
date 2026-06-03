import { describe, expect, it } from "vitest";
import { createSlackReplyDeliveryPlan } from "./replies.js";

describe("createSlackReplyDeliveryPlan", () => {
  it("peeks the next thread target without consuming first-reply state", () => {
    const hasRepliedRef = { value: false };
    const plan = createSlackReplyDeliveryPlan({
      replyToMode: "first",
      incomingThreadTs: undefined,
      messageTs: "171234.111",
      hasRepliedRef,
      isThreadReply: false,
    });

    expect(plan.peekThreadTs()).toBe("171234.111");
    expect(plan.peekThreadTs()).toBe("171234.111");
    expect(hasRepliedRef.value).toBe(false);

    expect(plan.nextThreadTs()).toBe("171234.111");
    expect(plan.peekThreadTs()).toBeUndefined();
    expect(hasRepliedRef.value).toBe(false);

    plan.markSent();
    expect(hasRepliedRef.value).toBe(true);
  });
});
