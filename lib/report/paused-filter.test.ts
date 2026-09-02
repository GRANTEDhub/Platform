import { describe, it, expect } from "vitest";
import { isPausedClientCard, filterPausedCards } from "./paused-filter";

// A card as the /review query returns it — only the joined client's match_active matters here.
const card = (match_active: boolean | null | undefined, id = "x") => ({
  id,
  clients: match_active === undefined ? ({} as { match_active?: boolean | null }) : { match_active },
});

describe("isPausedClientCard", () => {
  it("is paused ONLY when the client is explicitly match_active=false", () => {
    expect(isPausedClientCard(card(false))).toBe(true);
    expect(isPausedClientCard(card(true))).toBe(false);
  });

  it("fails toward SHOWING: null client, missing column, and null value are never paused", () => {
    // Prospect card (no client join).
    expect(isPausedClientCard({ clients: null })).toBe(false);
    // Legacy row read before the column existed (undefined).
    expect(isPausedClientCard(card(undefined))).toBe(false);
    // Explicit null (defensive; the column is NOT NULL, but the join type allows it).
    expect(isPausedClientCard(card(null))).toBe(false);
  });
});

describe("filterPausedCards", () => {
  const cards = [
    card(true, "a"), // active
    card(false, "b"), // paused
    card(false, "c"), // paused
    { id: "d", clients: null }, // prospect (never paused)
  ];

  it("hides paused-client cards by default and keeps active + prospect cards", () => {
    const { visible, pausedCount } = filterPausedCards(cards, false);
    expect(visible.map((c) => c.id)).toEqual(["a", "d"]);
    expect(pausedCount).toBe(2);
  });

  it("shows everything when showPaused is true, and the count is unchanged", () => {
    const { visible, pausedCount } = filterPausedCards(cards, true);
    expect(visible.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
    // Count is derived from the FULL set, so the toggle label stays accurate while shown.
    expect(pausedCount).toBe(2);
  });

  it("reports zero paused when nothing is paused (toggle stays hidden)", () => {
    const { visible, pausedCount } = filterPausedCards([card(true, "a"), card(true, "b")], false);
    expect(visible.map((c) => c.id)).toEqual(["a", "b"]);
    expect(pausedCount).toBe(0);
  });

  it("never mutates the input array", () => {
    const input = [...cards];
    filterPausedCards(input, false);
    expect(input.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  });
});
