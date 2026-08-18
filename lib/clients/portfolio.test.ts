import { describe, it, expect } from "vitest";
import { actionReason } from "./portfolio";

// The Portfolio split rule. The bug this locks: a client with 1–5 grants still pending our
// review used to fall to "no action" because the alert side gated on a backlog threshold
// (>= 6). One waiting card is enough now.

describe("actionReason", () => {
  const quiet = { alerts: 0, deadlineDays: null, questions: 0 };

  it("flags a client with ANY grant pending our review — one card is enough", () => {
    expect(actionReason({ ...quiet, alerts: 1 })).toBe("alerts");
    expect(actionReason({ ...quiet, alerts: 5 })).toBe("alerts");
  });

  it("leaves a client with zero pending reviews and no near deadline in the quiet index", () => {
    expect(actionReason(quiet)).toBeNull();
  });

  it("still flags a running deadline even with zero alerts, and ignores a far-off one", () => {
    expect(actionReason({ ...quiet, deadlineDays: 5 })).toBe("deadline");
    expect(actionReason({ ...quiet, deadlineDays: 9999 })).toBeNull();
  });

  it("keeps the reason priority question > deadline > alerts", () => {
    expect(actionReason({ alerts: 3, deadlineDays: 5, questions: 1 })).toBe("question");
    expect(actionReason({ alerts: 3, deadlineDays: 5, questions: 0 })).toBe("deadline");
    expect(actionReason({ alerts: 3, deadlineDays: 9999, questions: 0 })).toBe("alerts");
  });
});
