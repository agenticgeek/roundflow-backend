// Output lint (plan 3.8 layer 5). A model-written sentence containing a URL, markdown link, code, HTML, email address
// or phone number is dropped. Links come only from the closed `link.screen` enum, never from prose.

export type ProseKind = "intro" | "insight" | "follow_up";

/** Character caps per element (plan 3.8 layer 4). */
export const PROSE_LIMITS: Record<ProseKind, number> = { intro: 300, insight: 200, follow_up: 80 };

export type LintReason = "EMPTY" | "TOO_LONG" | "URL" | "MARKDOWN_LINK" | "CODE" | "HTML" | "EMAIL" | "PHONE" | "CONTROL_CHARS";

export type LintResult = { ok: true; text: string } | { ok: false; reason: LintReason };

const TLDS = "com|net|org|io|co|uk|ai|app|dev|info|biz|me|us|eu|gov|edu|xyz|online|site|link|ly";

// Order matters only for which reason is reported; any hit rejects the sentence.
const RULES: Array<[LintReason, RegExp]> = [
  ["CONTROL_CHARS", /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/],
  ["MARKDOWN_LINK", /!?\[[^\]]*\]\([^)]*\)/],
  ["CODE", /```|`|~~~|^\s{4,}\S|[{}]|=>/m],
  ["HTML", /<\s*\/?\s*[a-zA-Z!][^>]*>|&[a-z]{2,8};|&#\d+;/],
  ["EMAIL", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ["URL", new RegExp(`(?:\\b[a-z][a-z0-9+.-]*://|\\bwww\\.|\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})\\b(?:/|\\b))`, "i")],
  // A leading 0 or + that is not part of a longer number or an ISO date (2026-10-01 - 2026-10-30 is fine).
  ["PHONE", /(?:(?<![\d+-])\+\d|(?<![\d+-])0\d)[\d\s().-]{8,}\d|\d{10,}/],
];

/** Validates one element of prose. Returns the trimmed text when it passes. */
export function lintProse(raw: string, kind: ProseKind): LintResult {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "EMPTY" };
  if (text.length > PROSE_LIMITS[kind]) return { ok: false, reason: "TOO_LONG" };
  for (const [reason, re] of RULES) {
    if (re.test(text)) return { ok: false, reason };
  }
  return { ok: true, text };
}
