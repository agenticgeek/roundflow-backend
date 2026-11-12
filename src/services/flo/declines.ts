import type { DeclineCopy, ScopeVerdict } from "./types";

// Fixed refusal and capability copy (plan 3.8 layer 6). A decline is NEVER model-written: this file is the only source
// of text a decline can show, so a jailbreak cannot turn a refusal into an answer.

export const OUT_OF_SCOPE_TEXT =
  "I can only answer questions about your own RoundFlow data: rounds, jobs, payments, complaints and technicians.";
export const WRITE_REQUEST_TEXT = "Flo can only look things up for now. I can't change anything.";
export const NO_DATA_TEXT = "I couldn't find that in your RoundFlow data. Try one of these instead.";
export const CAPABILITY_TEXT = "I can look things up in your own RoundFlow data. Here are some questions to try.";

export interface SuggestionGroup {
  area: string;
  items: string[];
}

/** Static suggested questions by area. Served by GET /flo/suggestions and used as the "what can you do" reply. */
export const SUGGESTION_GROUPS: readonly SuggestionGroup[] = [
  { area: "Today", items: ["What is on today and who is behind?", "Summarise yesterday"] },
  { area: "Rounds", items: ["Which rounds are due next week and what are they worth?", "Show the skipped visits this week with reasons"] },
  { area: "Money owed", items: ["Who owes me more than £50 and for how long?", "What does Mrs Smith owe?"] },
  { area: "Payments", items: ["Show failed payments this month"] },
  { area: "Technicians", items: ["Compare my technicians for last month"] },
  { area: "Complaints", items: ["Show open complaints by severity, oldest first"] },
  { area: "Customers", items: ["Which customers skipped twice in a row?"] },
  { area: "Revenue", items: ["Revenue by service area, this month vs last"] },
] as const;

/** Three starter suggestions for a decline: the first item of the first three areas that matter most. */
const DECLINE_SUGGESTIONS: readonly string[] = [
  "What is on today and who is behind?",
  "Who owes me more than £50 and for how long?",
  "Show open complaints by severity, oldest first",
];

/** One suggestion per area (the capability reply). */
function capabilitySuggestions(): string[] {
  return SUGGESTION_GROUPS.map((g) => g.items[0]);
}

export type DeclineVerdict = Exclude<ScopeVerdict, "IN_SCOPE">;

/** The fixed decline for a non-IN_SCOPE verdict. UNSAFE reads exactly like OUT_OF_SCOPE (no hint about why). */
export function declineForVerdict(verdict: DeclineVerdict): DeclineCopy {
  switch (verdict) {
    case "WRITE_REQUEST":
      return { reason: "WRITE_REQUEST", text: WRITE_REQUEST_TEXT, suggestions: [...DECLINE_SUGGESTIONS] };
    case "CAPABILITY_QUESTION":
      return { reason: "CAPABILITY", text: CAPABILITY_TEXT, suggestions: capabilitySuggestions() };
    case "UNSAFE":
      return { reason: "UNSAFE", text: OUT_OF_SCOPE_TEXT, suggestions: [...DECLINE_SUGGESTIONS] };
    case "OUT_OF_SCOPE":
      return { reason: "OUT_OF_SCOPE", text: OUT_OF_SCOPE_TEXT, suggestions: [...DECLINE_SUGGESTIONS] };
  }
}

/** The answer had no tool data behind it (layer 3): replaced by this fixed decline. */
export function declineNoData(): DeclineCopy {
  return { reason: "NO_DATA_USED", text: NO_DATA_TEXT, suggestions: [...DECLINE_SUGGESTIONS] };
}
