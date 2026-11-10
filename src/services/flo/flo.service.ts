import { randomUUID } from "node:crypto";
import { Prisma } from "../../generated/tenant-client";
import { createAnthropicProvider } from "../../integrations/anthropic/client";
import { AppError } from "../../lib/app-error";
import { IDEMPOTENCY_STALE_MS, MAX_IDEMPOTENCY_KEY_LENGTH } from "../../lib/idempotency";
import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { answerText, type FinalAnswer, type FinalMessage, type FloEvent, type UserMessage } from "./answer";
import { declineForVerdict, declineNoData, SUGGESTION_GROUPS } from "./declines";
import { declineLimitPerDay, floEnabled, getDailyUsage, getDeclineCount } from "./limits";
import { DEFAULT_MODE, getModeConfig, isMode, listModes } from "./modes";
import { runOrchestrator, type OrchestratorResult, type ToolExecutor } from "./orchestrator";
import { MAX_MESSAGE_CHARS } from "./scope-gate";
import { buildFloContext } from "./system-prompt";
import type { DeclineCopy, DeclineReason, Mode, ModeConfig, ProviderClient, ProviderMessage, ProviderUsage } from "./types";

// Flo conversations, caps and the chat pipeline's persistence (plan 3.5 steps 1, 5, 6, 7). The route calls `prepare()`
// for every pre-stream check (plain HTTP errors), then drives `handle.events(signal)` into the SSE writer.
//
// Persistence: the user message at prepare time; the assistant message (OK / ERROR / DECLINED / ABORTED) when the
// pipeline ends. The daily cap is counted from OK rows; the decline cap from DECLINED rows excluding CAPABILITY.
// Idempotency-Key: same pattern as lib/idempotency.ts (insert first, the primary key is the lock), but the stored
// response is the FINAL MESSAGE, replayed as `start` + `done`.

export class FloError extends AppError {
  constructor(
    statusCode: number,
    message: string,
    code: string,
    public readonly resetsAt?: string
  ) {
    super(statusCode, message, code);
    this.name = "FloError";
  }
}

export const HISTORY_TURNS = 10;
export const IDEMPOTENCY_ROUTE = "POST /flo/chat";
const TITLE_CHARS = 60;
const ZERO_USAGE: ProviderUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

export interface FloServiceDeps {
  provider?: ProviderClient;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  timeoutMs?: number;
  execute?: ToolExecutor;
  newId?: () => string;
}

export interface ChatRequest {
  profileId: string;
  body: unknown;
  idempotencyKey?: string;
}

export interface ChatHandle {
  replayed: boolean;
  conversationId: string;
  messageId: string;
  mode: Mode;
  /** The SSE events for this chat turn. Persists the result; never throws. */
  events(signal: AbortSignal): AsyncGenerator<FloEvent, void, void>;
}

let sharedProvider: ProviderClient | undefined;
function defaultProvider(env: NodeJS.ProcessEnv): ProviderClient {
  return (sharedProvider ??= createAnthropicProvider({ env }));
}

const invalid = (message: string) => new FloError(400, message, "INVALID_MESSAGE");

export function parseChatBody(body: unknown): { message: string; mode: Mode; conversationId?: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("Send a JSON object with a message.");
  const { message, mode, conversationId } = body as Record<string, unknown>;
  if (typeof message !== "string" || message.trim() === "") throw invalid("Type a question for Flo.");
  if (message.length > MAX_MESSAGE_CHARS) throw invalid(`Keep the question under ${MAX_MESSAGE_CHARS} characters.`);
  if (mode !== undefined && !isMode(mode)) throw invalid("Choose Thorough, Balanced or Quick.");
  if (conversationId !== undefined && (typeof conversationId !== "string" || conversationId === "" || conversationId.length > 64)) {
    throw invalid("conversationId is not valid.");
  }
  return { message: message.trim(), mode: mode ?? DEFAULT_MODE, conversationId };
}

/** First line of the question, at most 60 characters, cut at a word boundary. */
export function makeTitle(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  if (line.length <= TITLE_CHARS) return line;
  const cut = line.slice(0, TITLE_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const DECLINES: Record<string, () => DeclineCopy> = {
  OUT_OF_SCOPE: () => declineForVerdict("OUT_OF_SCOPE"),
  WRITE_REQUEST: () => declineForVerdict("WRITE_REQUEST"),
  UNSAFE: () => declineForVerdict("UNSAFE"),
  CAPABILITY: () => declineForVerdict("CAPABILITY_QUESTION"),
  NO_DATA_USED: declineNoData,
};

interface MessageRow {
  id: string;
  role: "USER" | "ASSISTANT";
  mode: string | null;
  model: string | null;
  text: string;
  answer: unknown;
  warnings: string[];
  status: "OK" | "ERROR" | "DECLINED" | "ABORTED";
  declineReason: string | null;
  errorCode: string | null;
  createdAt: Date;
}

/** The shape of one message in `done` and in GET /flo/conversations/{id}. */
export function toMessage(row: MessageRow): UserMessage | FinalMessage {
  return row.role === "USER" ? { id: row.id, role: "USER", text: row.text, createdAt: row.createdAt.toISOString() } : toAssistantMessage(row);
}

function toAssistantMessage(row: MessageRow): FinalMessage {
  const reason = row.declineReason ?? "OUT_OF_SCOPE";
  const declined: DeclineCopy | null =
    row.status === "DECLINED" ? { reason: reason as DeclineReason, text: row.text, suggestions: (DECLINES[reason] ?? DECLINES.OUT_OF_SCOPE)().suggestions } : null;
  return {
    id: row.id,
    role: "ASSISTANT",
    mode: isMode(row.mode) ? row.mode : null,
    model: row.model,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    declined,
    answer: row.status === "OK" ? (row.answer as FinalAnswer) : null,
    warnings: row.warnings,
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
  };
}

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
const MAX_CLAIM_ATTEMPTS = 3;

export function createFloService(tp: TenantPrismaClient, deps: FloServiceDeps = {}) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  // ---- idempotency ---------------------------------------------------------------------------------------------------

  const keyOf = (profileId: string, clientKey: string) => `flo:${profileId}:${clientKey}`;

  const release = async (key: string): Promise<void> => {
    try {
      await tp.idempotencyRecord.deleteMany({ where: { key } });
    } catch (err) {
      console.error("[flo] failed to release idempotency key:", err instanceof Error ? err.name : "unknown");
    }
  };

  /** Claims the key, or returns the stored final message to replay. Throws 409 while the first request is running. */
  async function claim(profileId: string, clientKey: string): Promise<{ key: string; replay: { conversationId: string; message: FinalMessage } | null }> {
    const key = keyOf(profileId, clientKey);
    for (let attempt = 0; ; attempt++) {
      try {
        await tp.idempotencyRecord.create({ data: { key, actorId: profileId, route: IDEMPOTENCY_ROUTE, state: "IN_PROGRESS" } });
        return { key, replay: null };
      } catch (err) {
        if (!isUniqueViolation(err) || attempt >= MAX_CLAIM_ATTEMPTS - 1) throw err;
        const existing = await tp.idempotencyRecord.findUnique({ where: { key } });
        if (!existing) continue; // released in between: claim again
        if (existing.state === "DONE") return { key, replay: existing.responseBody as unknown as { conversationId: string; message: FinalMessage } };
        const staleBefore = new Date(Date.now() - IDEMPOTENCY_STALE_MS);
        if (existing.createdAt >= staleBefore) {
          throw new FloError(409, "This question is still being answered.", "FLO_REQUEST_IN_PROGRESS");
        }
        await tp.idempotencyRecord.deleteMany({ where: { key, state: "IN_PROGRESS", createdAt: { lt: staleBefore } } });
      }
    }
  }

  const store = async (key: string, conversationId: string, message: FinalMessage): Promise<void> => {
    try {
      await tp.idempotencyRecord.update({
        where: { key },
        data: { state: "DONE", responseStatus: 200, responseBody: JSON.parse(JSON.stringify({ conversationId, message })) as Prisma.InputJsonValue },
      });
    } catch (err) {
      console.error("[flo] failed to store idempotent response:", err instanceof Error ? err.name : "unknown");
      await release(key);
    }
  };

  // ---- read side -----------------------------------------------------------------------------------------------------

  async function status(): Promise<{ enabled: boolean; modes: Array<{ key: Mode; label: string; description: string }>; dailyRemaining: number }> {
    const usage = await getDailyUsage(tp, now(), env);
    return {
      enabled: floEnabled(env),
      modes: listModes(env).map(({ key, label, description }) => ({ key, label, description })),
      dailyRemaining: usage.remaining,
    };
  }

  const suggestions = () => ({ groups: SUGGESTION_GROUPS.map((g) => ({ area: g.area, questions: [...g.items] })) });

  async function listConversations(profileId: string, opts: { cursor?: string; limit?: number } = {}) {
    const limit = opts.limit ?? 30;
    const rows = await tp.floConversation.findMany({
      where: { profileId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: { id: true, title: true, updatedAt: true },
    });
    const page = rows.slice(0, limit);
    return {
      conversations: page.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt.toISOString() })),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  const notFound = () => new FloError(404, "Conversation not found.", "FLO_CONVERSATION_NOT_FOUND");

  async function getConversation(profileId: string, id: string) {
    const conv = await tp.floConversation.findFirst({
      where: { id, profileId },
      select: { id: true, title: true, messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
    });
    if (!conv) throw notFound();
    return { id: conv.id, title: conv.title, messages: (conv.messages as MessageRow[]).map(toMessage) };
  }

  async function deleteConversation(profileId: string, id: string): Promise<void> {
    const { count } = await tp.floConversation.deleteMany({ where: { id, profileId } });
    if (count === 0) throw notFound();
  }

  // ---- chat ----------------------------------------------------------------------------------------------------------

  async function checkCaps(profileId: string): Promise<void> {
    const usage = await getDailyUsage(tp, now(), env);
    if (usage.remaining <= 0) {
      throw new FloError(429, "Flo has reached today's limit. It resets at midnight.", "FLO_DAILY_LIMIT", usage.resetsAt.toISOString());
    }
    if ((await getDeclineCount(tp, profileId, now())) >= declineLimitPerDay(env)) {
      throw new FloError(429, "Flo can only help with your RoundFlow data.", "FLO_DECLINE_LIMIT");
    }
  }

  /** All pre-stream checks. Throws FloError (a plain HTTP error) before anything is streamed. */
  async function prepare(req: ChatRequest): Promise<ChatHandle> {
    const { message, mode, conversationId } = parseChatBody(req.body);
    if (!floEnabled(env)) throw new FloError(503, "Flo is not switched on for this account.", "FLO_UNAVAILABLE");
    const clientKey = req.idempotencyKey;
    if (clientKey !== undefined && (clientKey.trim() === "" || clientKey.length > MAX_IDEMPOTENCY_KEY_LENGTH)) {
      throw new FloError(400, `Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`, "INVALID_IDEMPOTENCY_KEY");
    }

    const claimed = clientKey === undefined ? null : await claim(req.profileId, clientKey);
    if (claimed?.replay) return replayHandle(claimed.replay);

    let convId: string;
    let userMessageId: string;
    try {
      if (conversationId) {
        const own = await tp.floConversation.findFirst({ where: { id: conversationId, profileId: req.profileId }, select: { id: true } });
        if (!own) throw notFound();
      }
      await checkCaps(req.profileId);
      convId = conversationId ?? (await tp.floConversation.create({ data: { profileId: req.profileId, title: makeTitle(message) }, select: { id: true } })).id;
      userMessageId = (await tp.floMessage.create({ data: { conversationId: convId, role: "USER", text: message, mode }, select: { id: true } })).id;
    } catch (err) {
      if (claimed) await release(claimed.key);
      throw err;
    }
    const conv = convId;
    const messageId = newId();
    const cfg = getModeConfig(mode, env);
    return {
      replayed: false,
      conversationId: conv,
      messageId,
      mode,
      events: (signal) => run({ profileId: req.profileId, message, cfg, conversationId: conv, messageId, userMessageId, key: claimed?.key, signal }),
    };
  }

  function replayHandle(stored: { conversationId: string; message: FinalMessage }): ChatHandle {
    const { message } = stored;
    const mode = message.mode as Mode; // stored OK and DECLINED messages always carry their mode
    return {
      replayed: true,
      conversationId: stored.conversationId,
      messageId: message.id,
      mode,
      async *events() {
        yield { event: "start", data: { conversationId: stored.conversationId, messageId: message.id, mode } };
        if (message.declined) yield { event: "declined", data: { reason: message.declined.reason, text: message.declined.text, suggestions: message.declined.suggestions } };
        yield { event: "done", data: { message } };
      },
    };
  }

  interface RunArgs {
    profileId: string;
    message: string;
    cfg: ModeConfig;
    conversationId: string;
    messageId: string;
    userMessageId: string;
    key?: string;
    signal: AbortSignal;
  }

  async function loadHistory(a: RunArgs): Promise<{ history: ProviderMessage[]; previousIntro?: string }> {
    const rows = await tp.floMessage.findMany({
      where: {
        conversationId: a.conversationId,
        id: { not: a.userMessageId },
        OR: [{ role: "USER" }, { role: "ASSISTANT", status: "OK" }],
      },
      orderBy: { createdAt: "desc" },
      take: HISTORY_TURNS,
      select: { role: true, text: true, answer: true },
    });
    const lastAnswer = rows.find((r) => r.role === "ASSISTANT")?.answer as { intro?: unknown } | null | undefined;
    const previousIntro = typeof lastAnswer?.intro === "string" && lastAnswer.intro !== "" ? lastAnswer.intro : undefined;
    const turns: ProviderMessage[] = rows
      .reverse()
      .filter((r) => r.text.trim() !== "")
      .map((r) => ({ role: r.role === "USER" ? ("user" as const) : ("assistant" as const), content: r.text }));
    if (turns[0]?.role === "assistant") turns.shift(); // a conversation sent to the provider must start with the user
    return { history: turns, previousIntro };
  }

  async function* pipeline(a: RunArgs): AsyncGenerator<FloEvent, OrchestratorResult, void> {
    const { history, previousIntro } = await loadHistory(a);
    const context = await buildFloContext(tp, now());
    const orchestrator = runOrchestrator(
      { provider: deps.provider ?? defaultProvider(env), env, timeoutMs: deps.timeoutMs, execute: deps.execute },
      {
        message: a.message,
        mode: a.cfg,
        history,
        previousIntro,
        toolCtx: { scope: "ADMIN", tenantPrisma: tp, profileId: a.profileId, now: now() },
        context,
        signal: a.signal,
      }
    );
    return yield* orchestrator;
  }

  async function persist(a: RunArgs, result: OrchestratorResult, durationMs: number): Promise<FinalMessage> {
    const base = {
      id: a.messageId,
      conversationId: a.conversationId,
      role: "ASSISTANT" as const,
      mode: a.cfg.key,
      model: result.kind === "answered" || result.kind === "declined" ? result.model : a.cfg.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedTokens: result.usage.cachedTokens,
      toolCalls: JSON.parse(JSON.stringify(result.toolCalls)) as Prisma.InputJsonValue,
      durationMs,
    };
    let data: Prisma.FloMessageUncheckedCreateInput;
    switch (result.kind) {
      case "answered":
        data = { ...base, status: "OK", text: answerText(result.answer), answer: JSON.parse(JSON.stringify(result.answer)) as Prisma.InputJsonValue, warnings: result.warnings };
        break;
      case "declined":
        data = { ...base, status: "DECLINED", text: result.decline.text, declineReason: result.decline.reason };
        break;
      case "failed":
        data = { ...base, status: "ERROR", text: "", errorCode: result.code };
        break;
      case "aborted":
        data = { ...base, status: "ABORTED", text: "" };
        break;
    }
    const row = await tp.floMessage.create({ data });
    await tp.floConversation.update({ where: { id: a.conversationId }, data: { updatedAt: now() } });
    return toAssistantMessage(row as unknown as MessageRow);
  }

  async function* run(a: RunArgs): AsyncGenerator<FloEvent, void, void> {
    const started = Date.now();
    yield { event: "start", data: { conversationId: a.conversationId, messageId: a.messageId, mode: a.cfg.key } };

    let result: OrchestratorResult;
    try {
      result = yield* pipeline(a);
    } catch (err) {
      console.error("[flo] pipeline failed:", err instanceof Error ? err.name : "unknown");
      result = { kind: "failed", code: "FLO_INTERNAL_ERROR", message: "Something went wrong on our side. Try again.", retryable: true, usage: ZERO_USAGE, toolCalls: [] };
    }

    let saved: FinalMessage;
    try {
      saved = await persist(a, result, Date.now() - started);
    } catch (err) {
      console.error("[flo] failed to persist the answer:", err instanceof Error ? err.name : "unknown");
      if (a.key) await release(a.key);
      yield { event: "error", data: { code: "FLO_INTERNAL_ERROR", message: "Something went wrong on our side. Try again.", retryable: true } };
      return;
    }

    if (result.kind === "answered" || result.kind === "declined") {
      if (a.key) await store(a.key, a.conversationId, saved);
      yield { event: "done", data: { message: saved } };
      return;
    }
    if (a.key) await release(a.key);
    if (result.kind === "failed") yield { event: "error", data: { code: result.code, message: result.message, retryable: result.retryable } };
  }

  return { status, suggestions, listConversations, getConversation, deleteConversation, prepare };
}

export type FloService = ReturnType<typeof createFloService>;
