import { describe, it, expect, afterEach } from "vitest";
import {
  grantbotVisionEnabled,
  validateTurnImage,
  base64DecodedByteLength,
  buildImageUserContent,
  IMAGE_INSTRUCTION_BLOCK,
  IMAGE_ATTACHED_NOTE,
  type TurnImage,
} from "./vision";
import { MAX_IMAGE_BYTES, ALLOWED_IMAGE_MIME } from "./label";

// A 3-byte payload ("AAAA") — real base64, decodes to 3 bytes. Enough to pass the non-empty gate.
const OK_B64 = "AAAA";
const okImage = (mediaType = "image/png"): unknown => ({ data: OK_B64, mediaType });

describe("base64DecodedByteLength — measure without allocating the buffer", () => {
  it("counts 3 bytes per 4 chars, minus padding", () => {
    expect(base64DecodedByteLength("")).toBe(0);
    expect(base64DecodedByteLength("AAAA")).toBe(3); // no padding
    expect(base64DecodedByteLength("AAA=")).toBe(2); // one pad
    expect(base64DecodedByteLength("AA==")).toBe(1); // two pad
  });

  it("agrees with a real Buffer decode for a known image-ish payload", () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]); // 9 bytes
    const b64 = bytes.toString("base64");
    expect(base64DecodedByteLength(b64)).toBe(9);
  });
});

describe("validateTurnImage — the server backstop; never throws", () => {
  it("accepts a PNG and a JPEG within the cap", () => {
    expect(validateTurnImage(okImage("image/png"))).toEqual({ data: OK_B64, mediaType: "image/png" });
    expect(validateTurnImage(okImage("image/jpeg"))).toEqual({ data: OK_B64, mediaType: "image/jpeg" });
  });

  it("rejects non-objects, missing/empty data, and non-string fields → null (not a throw)", () => {
    expect(validateTurnImage(null)).toBeNull();
    expect(validateTurnImage(undefined)).toBeNull();
    expect(validateTurnImage("nope")).toBeNull();
    expect(validateTurnImage({ mediaType: "image/png" })).toBeNull(); // no data
    expect(validateTurnImage({ data: "", mediaType: "image/png" })).toBeNull(); // empty data
    expect(validateTurnImage({ data: OK_B64, mediaType: 123 })).toBeNull(); // non-string mime
  });

  it("rejects a disallowed media type (GIF/WebP/PDF) — the whitelist holds", () => {
    expect(validateTurnImage({ data: OK_B64, mediaType: "image/gif" })).toBeNull();
    expect(validateTurnImage({ data: OK_B64, mediaType: "image/webp" })).toBeNull();
    expect(validateTurnImage({ data: OK_B64, mediaType: "application/pdf" })).toBeNull();
  });

  it("rejects an over-cap image (decoded size beyond the limit)", () => {
    // 8 chars → 6 decoded bytes; a 5-byte cap rejects it, a 6-byte cap accepts it (boundary).
    const eight = "AAAAAAAA";
    expect(validateTurnImage({ data: eight, mediaType: "image/png" }, 5)).toBeNull();
    expect(validateTurnImage({ data: eight, mediaType: "image/png" }, 6)).toEqual({ data: eight, mediaType: "image/png" });
  });

  it("the image cap sits below the file-attach cap so base64 fits the turn body", () => {
    expect(MAX_IMAGE_BYTES).toBe(3 * 1024 * 1024); // ~4 MB base64, under Vercel's ~4.5 MB body limit
    expect([...ALLOWED_IMAGE_MIME]).toEqual(["image/png", "image/jpeg"]);
  });
});

describe("buildImageUserContent — the current turn's content when an image rides it", () => {
  it("puts the image block FIRST, then the staffer's text", () => {
    const image: TurnImage = { data: OK_B64, mediaType: "image/png" };
    const content = buildImageUserContent("Is Bentonville in the zone?", image) as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: OK_B64 },
    });
    expect(content[1]).toEqual({ type: "text", text: "Is Bentonville in the zone?" });
  });
});

describe("grantbotVisionEnabled — flag reader, default OFF", () => {
  const prev = process.env.GRANTBOT_VISION_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.GRANTBOT_VISION_ENABLED;
    else process.env.GRANTBOT_VISION_ENABLED = prev;
  });

  it("is true ONLY for the exact string 'true'", () => {
    delete process.env.GRANTBOT_VISION_ENABLED;
    expect(grantbotVisionEnabled()).toBe(false);
    process.env.GRANTBOT_VISION_ENABLED = "false";
    expect(grantbotVisionEnabled()).toBe(false);
    process.env.GRANTBOT_VISION_ENABLED = "1";
    expect(grantbotVisionEnabled()).toBe(false);
    process.env.GRANTBOT_VISION_ENABLED = "true";
    expect(grantbotVisionEnabled()).toBe(true);
  });
});

describe("framing + stored-note constants", () => {
  it("the framing block is per-turn (cacheable:false) and frames the image as untrusted evidence", () => {
    expect(IMAGE_INSTRUCTION_BLOCK.cacheable).toBe(false);
    expect(IMAGE_INSTRUCTION_BLOCK.text).toContain("UNTRUSTED");
    // Honesty-about-an-unreadable-image is required, not optional.
    expect(IMAGE_INSTRUCTION_BLOCK.text.toLowerCase()).toContain("say so");
  });

  it("the stored note says an image was attached and is not retained", () => {
    expect(IMAGE_ATTACHED_NOTE).toContain("image");
    expect(IMAGE_ATTACHED_NOTE.toLowerCase()).toContain("not retained");
  });
});
