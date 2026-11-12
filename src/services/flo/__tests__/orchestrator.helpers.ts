import { ProviderError } from "../../../integrations/anthropic/client";
import type { FloEvent } from "../answer";
import { getModeConfig } from "../modes";
import { runOrchestrator, type OrchestratorDeps, type OrchestratorInput, type OrchestratorResult } from "../orchestrator";
import type { FloContext } from "../system-prompt";
import type { ProviderClient, ProviderRequest, ProviderResponse, ProviderStreamEvent, ProviderUsage } from "../types";
import { ctxFor, fakePrisma } from "../tools/__tests__/fake-prisma";

// Shared scaffolding for the Flo pipeline tests: a scripted fake provider (the classifier and the streaming main model),
// a fake tenant client with one skipped visit, and a helper that drains the orchestrator generator.

export const CONTEXT: FloContext = {
  businessName: "Test Windows",
  timeZone: "Europe/London",
  today: "2026-11-10",
  weekday: "Tuesday",
  currency: "GBP",
  workingDays: ["MON", "TUE", "WED", "THU", "FRI"],
};

export const USAGE: ProviderUsage = { inputTokens: 100, outputTokens: 20, cachedTokens: 10 };

export type Turn = ProviderStreamEvent[] | ((req: ProviderRequest) => AsyncGenerator<ProviderStreamEvent, void, void>);

export const toolTurn = (...calls: Array<{ id: string; name: string; input?: unknown }>): ProviderStreamEvent[] => [
  ...calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input ?? {} })),
  {
    type: "message_end",
    stopReason: "tool_use",
    usage: USAGE,
    content: calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input ?? {} })),
  },
];

/** A final-answer turn: the text arrives in small chunks (default 5 chars) so tags split across deltas. */
export const answerTurn = (text: string, chunk = 5, stopReason: "end_turn" | "max_tokens" | "refusal" = "end_turn"): ProviderStreamEvent[] => {
  const events: ProviderStreamEvent[] = [];
  for (let i = 0; i < text.length; i += chunk) events.push({ type: "text_delta", text: text.slice(i, i + chunk) });
  events.push({ type: "message_end", stopReason, usage: USAGE, content: [{ type: "text", text }] });
  return events;
};

/** A stream that hangs until the request is aborted, then fails like the real wrapper does. */
export const hangTurn: Turn = async function* (req) {
  await new Promise<void>((resolve) => {
    if (req.signal?.aborted) resolve();
    req.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  throw new ProviderError("PROVIDER_ABORTED", "The request was cancelled");
};

export const failTurn = (err: unknown, before: ProviderStreamEvent[] = []): Turn =>
  async function* () {
    yield* before;
    throw err;
  };

export interface Scripted {
  provider: ProviderClient;
  classifierCalls: ProviderRequest[];
  streamCalls: ProviderRequest[];
}

export function scripted(turns: Turn[], verdict: string | (() => Promise<string>) = "IN_SCOPE"): Scripted {
  const classifierCalls: ProviderRequest[] = [];
  const streamCalls: ProviderRequest[] = [];
  let n = 0;
  const provider: ProviderClient = {
    async createMessage(req) {
      classifierCalls.push(req);
      const text = typeof verdict === "string" ? verdict : await verdict();
      const res: ProviderResponse = { content: [{ type: "text", text }], stopReason: "end_turn", usage: USAGE, model: req.model };
      return res;
    },
    async *streamMessage(req) {
      // Copy the messages: the orchestrator appends to its own array between turns.
      streamCalls.push({ ...req, messages: structuredClone(req.messages) });
      const turn = turns[Math.min(n++, turns.length - 1)];
      if (typeof turn === "function") yield* turn(req);
      else yield* turn;
    },
  };
  return { provider, classifierCalls, streamCalls };
}

export const skippedVisit = (over: Record<string, unknown> = {}) => ({
  date: new Date("2026-11-05T00:00:00Z"),
  skipReason: "No access",
  round: { name: "Round 7" },
  technician: { name: "Liam" },
  property: { addressLine: "12 Oak Road", customer: { name: "Mrs Smith" } },
  ...over,
});

export function tenantWithSkips(visits: unknown[] = [skippedVisit(), skippedVisit({ date: new Date("2026-11-03T00:00:00Z"), skipReason: "Dog in garden" })]) {
  return fakePrisma({ "visit.count": visits.length, "visit.findMany": visits, "round.findUnique": { id: "round-7" } });
}

export function inputFor(over: Partial<OrchestratorInput> & { tp?: ReturnType<typeof tenantWithSkips> } = {}): OrchestratorInput {
  const tp = over.tp ?? tenantWithSkips();
  return {
    message: "Show the skipped visits this month",
    mode: getModeConfig("BALANCED", {} as NodeJS.ProcessEnv),
    history: [],
    toolCtx: ctxFor(tp.tp),
    context: CONTEXT,
    signal: new AbortController().signal,
    ...over,
  };
}

export async function drain(deps: OrchestratorDeps, input: OrchestratorInput): Promise<{ events: FloEvent[]; result: OrchestratorResult }> {
  const events: FloEvent[] = [];
  const gen = runOrchestrator({ env: {} as NodeJS.ProcessEnv, ...deps }, input);
  for (;;) {
    const next = await gen.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

export const names = (events: FloEvent[]) => events.map((e) => e.event);

export const GOOD_ANSWER =
  "chatter <intro>You have 2 skipped visits this month.</intro>" +
  '<block>{"type":"cards","items":[{"label":"Skipped","sourceId":"r1","path":"totals.skipped","sub":"this month"}]}</block>' +
  '<block>{"type":"table","title":"Skipped visits","sourceId":"r1","columns":["date","round","reason"],"link":{"screen":"ROUND","params":{"roundId":"round-7"}}}</block>' +
  "<insight>Round 7 had the most skips.</insight><follow_up>Show complaints</follow_up> trailing";
