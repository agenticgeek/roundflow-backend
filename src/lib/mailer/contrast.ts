// WCAG contrast helpers for tenant brand colours (GHL-11, BE-31). Button text is always black or white, whichever
// reaches at least 4.5:1 (one of them always does: the worst case is about 4.58:1).

export const DEFAULT_BRAND_COLOUR = "#00758C";
export const MIN_TEXT_CONTRAST = 4.5;

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

export function isHexColour(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(v);
}

export function normaliseHex(hex: string): string {
  return hex.toUpperCase();
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white, whichever reads better on `background`. */
export function readableTextColour(background: string): "#000000" | "#FFFFFF" {
  return contrastRatio(background, "#FFFFFF") >= contrastRatio(background, "#000000") ? "#FFFFFF" : "#000000";
}

function toHex(rgb: number[]): string {
  return "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** The brand colour darkened (towards black) until it reaches 4.5:1 on white; used for links and accents. */
export function safeAccentColour(hex: string): string {
  let current = normaliseHex(hex);
  let factor = 1;
  const rgb = channels(current);
  while (contrastRatio(current, "#FFFFFF") < MIN_TEXT_CONTRAST) {
    factor -= 0.05;
    current = toHex(rgb.map((c) => c * factor));
  }
  return current;
}

export interface BrandColourCheck {
  colour: string;
  /** Auto text colour for a button filled with `colour`. */
  textColour: "#000000" | "#FFFFFF";
  buttonContrast: number;
  warning: null | { code: "LOW_CONTRAST_ON_WHITE"; message: string; textColour: "#000000" | "#FFFFFF"; safeAccentColour: string };
}

/** Validates a (well-formed) brand colour. Buttons always pass (auto text colour); links/accents on white may not. */
export function checkBrandColour(hex: string): BrandColourCheck {
  const colour = normaliseHex(hex);
  const textColour = readableTextColour(colour);
  const onWhite = contrastRatio(colour, "#FFFFFF");
  return {
    colour,
    textColour,
    buttonContrast: contrastRatio(colour, textColour),
    warning:
      onWhite >= MIN_TEXT_CONTRAST
        ? null
        : {
            code: "LOW_CONTRAST_ON_WHITE",
            message: `${colour} has a contrast ratio of ${onWhite.toFixed(2)}:1 on white, below the 4.5:1 needed for text. Buttons use ${textColour} text (always readable); links and accents will use ${safeAccentColour(colour)} instead.`,
            textColour,
            safeAccentColour: safeAccentColour(colour),
          },
  };
}
