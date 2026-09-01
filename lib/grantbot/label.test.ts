import { describe, it, expect } from "vitest";
import { stripControlChars, truncateSafely, splitImageTag, IMAGE_ATTACHED_TAG } from "./label";

describe("stripControlChars", () => {
  it("collapses line-breaking code points to a space", () => {
    expect(stripControlChars("a\nb\tc")).toBe("a b c");
  });
  it("leaves an ordinary label untouched", () => {
    expect(stripControlChars("NOFO for the county grant.txt")).toBe("NOFO for the county grant.txt");
  });
  it("trims to empty when nothing but line-breakers remain", () => {
    expect(stripControlChars("\n\t\r")).toBe("");
  });
});

describe("truncateSafely", () => {
  it("returns text unchanged and truncated=false at or under the cap", () => {
    expect(truncateSafely("hello", 10)).toEqual({ text: "hello", truncated: false });
    expect(truncateSafely("hello", 5)).toEqual({ text: "hello", truncated: false });
  });
  it("truncates over the cap and flags it", () => {
    expect(truncateSafely("abcdef", 3)).toEqual({ text: "abc", truncated: true });
  });
  it("drops a dangling lone high surrogate when the cut splits an astral pair", () => {
    // "ab" + 😀 (a surrogate pair at indices 2,3) -> cutting at 3 would keep the lone high surrogate.
    const r = truncateSafely("ab😀cd", 3);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("ab"); // the half-emoji is dropped, not ridden into the output
    expect(r.text).toBe(r.text.toWellFormed());
  });
  it("keeps a whole astral char when the cut lands after its low surrogate", () => {
    const r = truncateSafely("a😀b", 3); // indices 0,1,2 = "a" + the full emoji
    expect(r.text).toBe("a😀");
    expect(r.text).toBe(r.text.toWellFormed());
  });
});

describe("splitImageTag", () => {
  it("splits a trailing image tag off, returning the body and hadImage", () => {
    expect(splitImageTag(`Read this png?\n\n${IMAGE_ATTACHED_TAG}`)).toEqual({
      body: "Read this png?",
      hadImage: true,
    });
  });
  it("returns an empty body when the message is only the tag", () => {
    expect(splitImageTag(IMAGE_ATTACHED_TAG)).toEqual({ body: "", hadImage: true });
  });
  it("leaves an ordinary message untouched (no false positive)", () => {
    expect(splitImageTag("What's the deadline?")).toEqual({ body: "What's the deadline?", hadImage: false });
    // The tag mid-text is NOT a trailing attachment marker — the body is left whole.
    expect(splitImageTag(`${IMAGE_ATTACHED_TAG} in the middle`)).toEqual({
      body: `${IMAGE_ATTACHED_TAG} in the middle`,
      hadImage: false,
    });
  });
  it("keeps a preceding pasted-content marker in the body (only the image tag is a chip)", () => {
    const r = splitImageTag(`Question\n\n[+ pasted content]\n\n${IMAGE_ATTACHED_TAG}`);
    expect(r).toEqual({ body: "Question\n\n[+ pasted content]", hadImage: true });
  });
});
