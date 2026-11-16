import { ProviderError } from "../../integrations/anthropic/client";
import { AnswerBuilder, type FinalAnswer, type FloErrorCode, type FloEvent } from "./answer";
import { buildDataSummary, type DataSummaryEntry } from "./data-summary";
import { declineNoData } from "./declines";
import { floTimeoutMs } from "./modes";
import { resolveScopeOutcome, runScopeGate } from "./scope-gate";
import { AnswerStreamParser, type ParsedElement } from "./stream-parser";
import { buildSystemParts, type FloContext } from "./system-prompt";
import { executeTool, isToolName, TOOL_REGISTRY, toolErrorForModel, toolResultForModel, toolSpecs } from "./tool-registry";
import type {
  DeclineCopy,
  ModeConfig,
  ProviderClient,
  ProviderContentBlock,
  ProviderMessage,
  ProviderRequest,
  ProviderUsage,
  ToolContext,
  ToolOutcome,
  ToolResult,
} from "./types";

// The Flo pipeline (plan 3.5), as an async event generator: scope gate -> tool loop -> streamed tagged answer ->
// sentence-level lint and figure check. It yields the SSE events for ONE chat turn (status, block, text, follow_ups,
// declined, warning) and RETURNS a result the service persists. It never throws: every failure is a `failed` result.
//
// Guarantees enforced here, not by the prompt:
//  - a question the scope gate does not pass IN_SCOPE makes no main-model call and runs no tool;
//  - nothing the model writes is shown until at least one tool result exists (an answer from memory emits nothing and
//    ends as the fixed NO_DATA decline);
//  - tool results go back to the model fenced as untrusted data; the model can only call registry tools;
//  - round, time and token caps; client abort stops the provider call and stops waiting for tools.

export interface ToolAudit {
  tool: string;
  sourceId: string;
  args: unknown;
  ok: boolean;
  rows: number | null;
  ms: number;
  error?: string;
}

export type OrchestratorResult =
  | { kind: "declined"; decline: DeclineCopy; usage: ProviderUsage; toolCalls: ToolAudit[]; model: string | null }
  | { kind: "answered"; answer: FinalAnswer; warnings: string[]; usage: ProviderUsage; toolCalls: ToolAudit[]; model: string; dataSummary: DataSummaryEntry[] }
  | { kind: "failed"; code: FloErrorCode; message: string; retryable: boolean; usage: ProviderUsage; toolCalls: ToolAudit[] }
  | { kind: "aborted"; usage: ProviderUsage; toolCalls: ToolAudit[] };

export type ToolExecutor = (name: string, rawInput: unknown, ctx: ToolContext, sourceId: string) => Promise<ToolOutcome>;

export interface OrchestratorDeps {
  provider: ProviderClient;
  env?: NodeJS.ProcessEnv;
  /** Whole-request budget in ms (default FLO_TIMEOUT_MS, 90 s). */
  timeoutMs?: number;
  /** Tool runner (default: the registry's executeTool). Injectable so a failing tool can be simulated. */
  execute?: ToolExecutor;
}

export interface OrchestratorInput {
  message: string;
  mode: ModeConfig;
  /** Earlier turns (assistant turns as final text only), WITHOUT the new message. */
  history: ProviderMessage[];
  /** The intro line of the previous answer, for the scope gate ("compare with September"). */
  previousIntro?: string;
  toolCtx: ToolContext;
  context: FloContext;
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
}

export const ERROR_COPY: Record<FloErrorCode, { message: string; retryable: boolean }> = {
  FLO_PROVIDER_ERROR: { message: "Flo could not reach its AI service. Try again.", retryable: true },
  FLO_TIMEOUT: { message: "That took too long. Try Balanced or Quick.", retryable: true },
  FLO_NO_ANSWER: { message: "Flo could not answer that. Try rephrasing.", retryable: false },
  FLO_INTERNAL_ERROR: { message: "Something went wrong on our side. Try again.", retryable: true },
};

class Interrupted extends Error {}

/** Sent to the model for an infrastructure failure (a query error, not bad arguments): retrying only wastes a round. */
export const INFRA_ERROR_FOR_MODEL =
  "This lookup failed because of a system problem, not because of your arguments. Do not retry it. Tell the user plainly that this part could not be looked up, and answer from the other data you have.";
/** Appended to the per-request system text on the last allowed round (tool_choice none), so gathered data is never thrown away. */
export const FINAL_ROUND_NOTE = "This is your last turn and no more lookups are possible. Answer now from the data you have already gathered, and say plainly what you could not check.";

/** The model's own dead end ("I can't look that up yet.") with nothing else in the answer. */
const CANT_LOOK_UP = /^\s*i can[’']?t look that up(?: yet)?[.!]?\s*$/i;
const isCantLookUp = (a: FinalAnswer): boolean => a.blocks.length === 0 && a.insights.length === 0 && CANT_LOOK_UP.test(a.intro);

/** The human label of a registry tool; an unknown tool name is never echoed. */
const labelOf = (name: string): string => (isToolName(name) ? TOOL_REGISTRY[name].label : "Lookup");

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Interrupted());
    const onAbort = () => reject(new Interrupted());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

interface PendingTool {
  id: string;
  name: string;
  sourceId: string;
  run: Promise<ToolOutcome>;
}

export async function* runOrchestrator(deps: OrchestratorDeps, input: OrchestratorInput): AsyncGenerator<FloEvent, OrchestratorResult, void> {
  const { provider, env = process.env } = deps;
  const execute = deps.execute ?? executeTool;
  const { mode } = input;
  const timeoutSignal = AbortSignal.timeout(deps.timeoutMs ?? floTimeoutMs(env));
  const signal = AbortSignal.any([input.signal, timeoutSignal]);
  const usage: ProviderUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const toolCalls: ToolAudit[] = [];

  const interrupted = (): OrchestratorResult | null => {
    if (input.signal.aborted) return { kind: "aborted", usage, toolCalls };
    if (timeoutSignal.aborted) return failed("FLO_TIMEOUT");
    return null;
  };
  const failed = (code: FloErrorCode, retryable?: boolean): OrchestratorResult => ({
    kind: "failed",
    code,
    message: ERROR_COPY[code].message,
    retryable: retryable ?? ERROR_COPY[code].retryable,
    usage,
    toolCalls,
  });
  const decline = (copy: DeclineCopy): FloEvent => ({ event: "declined", data: { reason: copy.reason, text: copy.text, suggestions: copy.suggestions } });

  // ---- layers 1 and 2: pre-checks and the scope gate (no tools, no main model) --------------------------------------
  const decision = await runScopeGate({ provider, env, signal }, { message: input.message, previousIntro: input.previousIntro });
  const stopped = interrupted();
  if (stopped) return stopped;
  const outcome = resolveScopeOutcome(decision);
  if (outcome.kind === "decline") {
    yield decline(outcome.decline);
    return { kind: "declined", decline: outcome.decline, usage, toolCalls, model: null };
  }

  // ---- the tool loop and the streamed answer -------------------------------------------------------------------------
  const results = new Map<string, ToolResult>();
  const knownIds = new Set<string>();
  const builder = new AnswerBuilder(mode, { results, knownIds });
  const { stable: system, dynamic: systemDynamic } = buildSystemParts(input.context, mode);
  const tools = toolSpecs();
  const toolCtx: ToolContext = { ...input.toolCtx, results };
  let forcedFinal = false;
  const messages: ProviderMessage[] = [...input.history, { role: "user", content: input.message }];
  let counter = 0;

  const flush = function* (elements: ParsedElement[]): Generator<FloEvent, void, void> {
    for (const el of elements) yield* builder.accept(el);
  };

  try {
    for (let round = 0; round < mode.maxRounds; round++) {
      const last = round === mode.maxRounds - 1;
      const dynamic = last ? [systemDynamic, FINAL_ROUND_NOTE].filter(Boolean).join("\n\n") : systemDynamic;
      const request: ProviderRequest = {
        model: mode.model,
        system,
        messages,
        tools,
        maxTokens: mode.maxOutputTokens,
        signal,
        systemDynamic: dynamic,
        ...(last ? { toolChoice: "none" as const } : {}),
        ...(mode.temperature !== undefined ? { temperature: mode.temperature } : {}),
        ...(mode.thinking !== undefined ? { thinking: mode.thinking } : {}),
      };
      const parser = new AnswerStreamParser();
      const pending: PendingTool[] = [];
      let content: ProviderContentBlock[] = [];

      for await (const ev of provider.streamMessage(request)) {
        if (ev.type === "text_delta") {
          // Text is only shown once a tool result exists, and never from a turn that has started calling tools.
          if (results.size > 0 && pending.length === 0) yield* flush(parser.push(ev.text));
        } else if (ev.type === "tool_use") {
          if (last) continue; // tool_choice is "none" on the last round: a stray call is ignored, never run
          const sourceId = `r${++counter}`;
          yield { event: "status", data: { phase: "checking", tool: ev.name.slice(0, 40), label: labelOf(ev.name) } };
          const run = execute(ev.name, ev.input, toolCtx, sourceId).catch((): ToolOutcome => ({ ok: false, error: INFRA_ERROR_FOR_MODEL, kind: "infrastructure", ms: 0 }));
          pending.push({ id: ev.id, name: ev.name, sourceId, run });
        } else {
          content = ev.content;
          usage.inputTokens += ev.usage.inputTokens;
          usage.outputTokens += ev.usage.outputTokens;
          usage.cachedTokens += ev.usage.cachedTokens;
        }
      }

      if (pending.length === 0) {
        yield* flush(parser.end());
        forcedFinal = last && round > 0;
        break;
      }

      const outcomes = await abortable(Promise.all(pending.map((p) => p.run)), signal);
      const resultBlocks: ProviderContentBlock[] = [];
      for (const [i, p] of pending.entries()) {
        const o = outcomes[i];
        toolCalls.push({
          tool: p.name.slice(0, 40),
          sourceId: p.sourceId,
          args: o.args ?? null,
          ok: o.ok,
          rows: o.ok ? o.result.rows.length : null,
          ms: o.ms,
          ...(o.ok ? {} : { error: o.error }),
        });
        if (o.ok) {
          results.set(p.sourceId, o.result);
          for (const [k, v] of Object.entries(Object(o.args) as Record<string, unknown>)) {
            if (k.endsWith("Id") && typeof v === "string") knownIds.add(v);
          }
        }
        yield { event: "status", data: { phase: "checked", tool: p.name.slice(0, 40), label: labelOf(p.name), ...(o.ok ? { rows: o.result.rows.length } : {}) } };
        resultBlocks.push({
          type: "tool_result",
          tool_use_id: p.id,
          content: o.ok ? toolResultForModel(o.result) : toolErrorForModel(o.kind === "infrastructure" ? INFRA_ERROR_FOR_MODEL : o.error),
          ...(o.ok ? {} : { is_error: true }),
        });
      }
      messages.push({ role: "assistant", content }, { role: "user", content: resultBlocks });
    }
  } catch (err) {
    return interrupted() ?? providerFailure(err, failed);
  }

  if (!builder.hasContent()) {
    // The forced last turn still produced nothing usable after tools ran: the only case that is a failure, not a decline.
    if (forcedFinal) return failed("FLO_NO_ANSWER");
    const copy = declineNoData();
    yield decline(copy);
    return { kind: "declined", decline: copy, usage, toolCalls, model: mode.model };
  }
  const done = builder.finish();
  if (isCantLookUp(done.answer)) {
    // Same dead end as NO_DATA_USED, so the unanswered-question log (GET /flo/gaps) lists it.
    const copy = declineNoData();
    yield decline(copy);
    return { kind: "declined", decline: copy, usage, toolCalls, model: mode.model };
  }
  yield* done.events;
  return { kind: "answered", answer: done.answer, warnings: done.warnings, usage, toolCalls, model: mode.model, dataSummary: buildDataSummary(results, toolCalls) };
}

function providerFailure(err: unknown, failed: (code: FloErrorCode, retryable?: boolean) => OrchestratorResult): OrchestratorResult {
  if (err instanceof ProviderError) {
    return err.code === "PROVIDER_TIMEOUT" ? failed("FLO_TIMEOUT") : failed("FLO_PROVIDER_ERROR", err.retryable);
  }
  return failed("FLO_INTERNAL_ERROR");
}
