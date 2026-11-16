import type { ToolResult } from "./types";

// Per-sentence grounding check (plan 3.5 / D4). Every number in a prose sentence must equal a value in a stored tool
// result, or a sum, difference, ratio or percent (change) of two of them (compared after rounding to the precision the
// sentence shows), or be a date, a year, a time, an ordinal or a
// rank (whitelisted). A sentence that fails is still sent, flagged `unverified`.

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

/** Numbers inside these patterns are not figures: they are removed before the check. */
const WHITELIST: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  /\b\d{1,2}:\d{2}(?:\s?[ap]m)?\b/gi,
  /\b\d{1,2}\s?[ap]m\b/gi,
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b(?:\\s+\\d{4})?`, "gi"),
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?`, "gi"),
  /\b\d+(?:st|nd|rd|th)\b/gi,
  /#\d+\b/g,
  /\btop\s+\d+\b/gi,
  /(?<![£\d,.])\b(?:19|20)\d{2}\b(?![,.]?\d)/g,
];

const NUMBER = /£?\d[\d,]*(?:\.\d+)?%?/g;

export function extractFigures(sentence: string): Array<{ value: number; decimals: number }> {
  let text = sentence;
  for (const re of WHITELIST) text = text.replace(re, " ");
  const out: Array<{ value: number; decimals: number }> = [];
  for (const token of text.match(NUMBER) ?? []) {
    const clean = token.replace(/[£%,]/g, "");
    out.push({ value: Number(clean), decimals: clean.includes(".") ? clean.length - clean.indexOf(".") - 1 : 0 });
  }
  return out;
}

function collectNumbers(result: ToolResult, into: Set<number>): void {
  const take = (cell: unknown): void => {
    if (typeof cell === "number" && Number.isFinite(cell)) into.add(Math.abs(cell));
    else if (typeof cell === "string") {
      for (const token of cell.match(NUMBER) ?? []) into.add(Number(token.replace(/[£%,]/g, "")));
    }
  };
  for (const row of result.rows) Object.values(row).forEach(take);
  if (result.totals) Object.values(result.totals).forEach(take);
  into.add(result.rows.length);
}

const at = (n: number, decimals: number): number => Number(n.toFixed(decimals));

/** Pair search is capped so a big answer cannot make the check expensive: 400 values = 160,000 ordered pairs at most. */
export const MAX_PAIR_VALUES = 400;

/** True when `target` (at `decimals`) equals sum, difference, ratio, percent-of or percent-change of any two known values. */
function isDerived(values: readonly number[], target: number, decimals: number): boolean {
  const scale = 10 ** decimals;
  const want = Math.round(target * scale); // integer compare is far cheaper than toFixed in a 160k-pair loop
  const hit = (n: number): boolean => Math.round(n * scale) === want;
  const n = Math.min(values.length, MAX_PAIR_VALUES);
  for (let i = 0; i < n; i++) {
    const a = values[i];
    for (let j = 0; j < n; j++) {
      const b = values[j];
      if (hit(a + b) || hit(Math.abs(a - b))) return true;
      if (b !== 0 && (hit(a / b) || hit((a / b) * 100) || hit(((a - b) / b) * 100) || hit((Math.abs(a - b) / b) * 100))) return true;
    }
  }
  return false;
}

export interface FigureCheck {
  ok: boolean;
  unmatched: number[];
}

/** Builds a checker over the tool results stored so far. */
export function createFigureChecker(results: Iterable<ToolResult>): (sentence: string) => FigureCheck {
  const known = new Set<number>();
  for (const r of results) collectNumbers(r, known);
  const values = [...known];
  return (sentence) => {
    const unmatched = extractFigures(sentence)
      .filter((f) => !values.some((v) => at(v, f.decimals) === at(f.value, f.decimals)) && !isDerived(values, f.value, f.decimals))
      .map((f) => f.value);
    return { ok: unmatched.length === 0, unmatched };
  };
}
