import { describe, expect, it } from "vitest";
import { checkBrandColour, contrastRatio, DEFAULT_BRAND_COLOUR, isHexColour, normaliseHex, readableTextColour, safeAccentColour } from "../contrast";

describe("hex helpers", () => {
  it("validates #RRGGBB only", () => {
    expect(isHexColour("#029BB6")).toBe(true);
    expect(isHexColour("#029bb6")).toBe(true);
    for (const bad of ["029BB6", "#fff", "#GGGGGG", "#029BB6;x", "red", "", "#12345678", 5, null]) expect(isHexColour(bad as never)).toBe(false);
  });
  it("normalises to upper case", () => {
    expect(normaliseHex("#029bb6")).toBe("#029BB6");
  });
});

describe("contrastRatio", () => {
  it("black on white is 21, identical is 1", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(contrastRatio("#336699", "#336699")).toBeCloseTo(1, 5);
  });
  it("is symmetric", () => {
    expect(contrastRatio("#029BB6", "#FFFFFF")).toBeCloseTo(contrastRatio("#FFFFFF", "#029BB6"), 8);
  });
  it("matches the known 3.3:1 of the old brand teal on white", () => {
    expect(contrastRatio("#029BB6", "#FFFFFF")).toBeCloseTo(3.3, 1);
  });
});

describe("readableTextColour", () => {
  it("picks black or white so the button text is always at least 4.5:1", () => {
    for (const hex of ["#029BB6", "#FFFFFF", "#000000", "#FF0000", "#00FF00", "#0000FF", "#777777", "#808080", "#FFD700", "#123456"]) {
      const text = readableTextColour(hex);
      expect(["#000000", "#FFFFFF"]).toContain(text);
      expect(contrastRatio(hex, text)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("uses dark text on light backgrounds and white on dark", () => {
    expect(readableTextColour("#FFFFFF")).toBe("#000000");
    expect(readableTextColour("#000000")).toBe("#FFFFFF");
  });
});

describe("safeAccentColour", () => {
  it("returns the colour untouched when it already passes 4.5:1 on white", () => {
    expect(safeAccentColour("#00758C")).toBe("#00758C");
  });
  it("darkens a failing colour until it passes", () => {
    const safe = safeAccentColour("#029BB6");
    expect(safe).not.toBe("#029BB6");
    expect(contrastRatio(safe, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
  });
  it("terminates for pure white", () => {
    expect(contrastRatio(safeAccentColour("#FFFFFF"), "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("checkBrandColour", () => {
  it("passes a dark colour with no warning", () => {
    const r = checkBrandColour("#00758C");
    expect(r).toMatchObject({ colour: "#00758C", textColour: "#FFFFFF", warning: null });
    expect(r.buttonContrast).toBeGreaterThanOrEqual(4.5);
  });
  it("warns for a colour that fails as text on white, with safe auto colours", () => {
    const r = checkBrandColour("#029bb6");
    expect(r.colour).toBe("#029BB6");
    expect(r.warning).toMatchObject({ code: "LOW_CONTRAST_ON_WHITE", safeAccentColour: expect.stringMatching(/^#[0-9A-F]{6}$/), textColour: r.textColour });
    expect(r.warning!.message).toMatch(/4\.5/);
    expect(contrastRatio(r.warning!.safeAccentColour, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
  });
  it("exports a default brand colour that passes", () => {
    expect(checkBrandColour(DEFAULT_BRAND_COLOUR).warning).toBeNull();
  });
});
