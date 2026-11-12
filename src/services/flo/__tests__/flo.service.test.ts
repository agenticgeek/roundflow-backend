import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalMessage, FloEvent } from "../answer";
import { SUGGESTION_GROUPS } from "../declines";
import { createFloService, FloError, makeTitle, parseChatBody, toMessage, type ChatHandle, type FloServiceDeps } from "../flo.service";
import { ProviderError } from "../../../integrations/anthropic/client";
import { IDEMPOTENCY_STALE_MS } from "../../../lib/idempotency";
import { fakeFloDb, p2002, skip, type FakeFloDb } from "./fake-flo-db";
import { answerTurn, failTurn, hangTurn, scripted, toolTurn, type Turn } from "./orchestrator.helpers";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const ENV = { ANTHROPIC_API_KEY: "test-key" } as unknown as NodeJS.ProcessEnv;

const GOOD: Turn[] = [
  toolTurn({ id: "t1", name: "list_skipped_visits" }),
  answerTurn('<intro>You have 2 skipped visits.</intro><block>{"type":"table","sourceId":"r1","columns":["date","reason"]}</block><insight>Round 7 had skips.</insight><follow_up>Show complaints</follow_up>'),
];

function setup(turns: Turn[] = GOOD, over: { verdict?: string; deps?: FloServiceDeps; db?: FakeFloDb } = {}) {
  const db = over.db ?? fakeFloDb();
  db.visits = [skip("2026-11-05", "No access"), skip("2026-11-03", "Dog in garden")];
  const s = scripted(turns, over.verdict ?? "IN_SCOPE");
  const svc = createFloService(db.tp, { provider: s.provider, env: ENV, now: () => NOW, newId: () => "msg-assistant", ...over.deps });
  return { db, s, svc };
}

async function collect(handle: ChatHandle, signal: AbortSignal = new AbortController().signal): Promise<FloEvent[]> {
  const out: FloEvent[] = [];
  for await (const e of handle.events(signal)) out.push(e);
  return out;
}

const chat = (svc: ReturnType<typeof createFloService>, body: unknown, extra: { profileId?: string; key?: string } = {}) =>
  svc.prepare({ profileId: extra.profileId ?? "p1", body, idempotencyKey: extra.key });

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("parseChatBody / makeTitle / toMessage", () => {
  it("accepts a valid body, trims, and defaults the mode to BALANCED", () => {
    expect(parseChatBody({ message: "  Who owes me money?  ", mode: "QUICK", conversationId: "c1" })).toEqual({ message: "Who owes me money?", mode: "QUICK", conversationId: "c1" });
    expect(parseChatBody({ message: "hi" })).toEqual({ message: "hi", mode: "BALANCED", conversationId: undefined });
  });

  it.each([
    [null], ["text"], [[]], [{}], [{ message: "   " }], [{ message: 5 }], [{ message: "x".repeat(2001) }],
    [{ message: "hi", mode: "FAST" }], [{ message: "hi", conversationId: 7 }], [{ message: "hi", conversationId: "" }], [{ message: "hi", conversationId: "c".repeat(65) }],
  ])("rejects %j with 400 INVALID_MESSAGE", (body) => {
    expect(() => parseChatBody(body)).toThrowError(expect.objectContaining({ statusCode: 400, code: "INVALID_MESSAGE" }));
  });

  it("accepts exactly 2000 characters", () => {
    expect(parseChatBody({ message: "x".repeat(2000) }).message).toHaveLength(2000);
  });

  it("makes a short title at a word boundary", () => {
    expect(makeTitle("  Who  owes me\nmoney? ")).toBe("Who owes me money?");
    const long = "Show me every customer who has skipped two visits in a row this year please";
    expect(makeTitle(long)).toBe("Show me every customer who has skipped two visits in a row…");
    expect(makeTitle("x".repeat(100))).toBe(`${"x".repeat(60)}…`);
  });

  it("maps rows: user text, declined with fixed suggestions, error code, unknown reason and mode", () => {
    const base = { id: "m", mode: "BALANCED", model: null, text: "t", answer: null, warnings: [] as string[], status: "OK", declineReason: null, errorCode: null, createdAt: NOW } as const;
    expect(toMessage({ ...base, role: "USER" })).toEqual({ id: "m", role: "USER", text: "t", createdAt: NOW.toISOString() });
    const declined = toMessage({ ...base, role: "ASSISTANT", status: "DECLINED", declineReason: "WRITE_REQUEST", text: "Flo can only look things up for now. I can't change anything." }) as FinalMessage;
    expect(declined).toMatchObject({ status: "DECLINED", answer: null, declined: { reason: "WRITE_REQUEST" } });
    expect(declined.declined?.suggestions).toHaveLength(3);
    const cap = toMessage({ ...base, role: "ASSISTANT", status: "DECLINED", declineReason: "CAPABILITY" }) as FinalMessage;
    expect(cap.declined?.suggestions).toEqual(SUGGESTION_GROUPS.map((g) => g.items[0]));
    const odd = toMessage({ ...base, role: "ASSISTANT", status: "DECLINED", declineReason: null, mode: "WEIRD" }) as FinalMessage;
    expect(odd).toMatchObject({ mode: null, declined: { reason: "OUT_OF_SCOPE" } });
    const mystery = toMessage({ ...base, role: "ASSISTANT", status: "DECLINED", declineReason: "MYSTERY" }) as FinalMessage;
    expect(mystery.declined?.suggestions).toHaveLength(3);
    const err = toMessage({ ...base, role: "ASSISTANT", status: "ERROR", errorCode: "FLO_TIMEOUT" }) as FinalMessage;
    expect(err).toMatchObject({ status: "ERROR", errorCode: "FLO_TIMEOUT", answer: null, declined: null });
    const ok = toMessage({ ...base, role: "ASSISTANT", answer: { intro: "x" } }) as FinalMessage;
    expect(ok.answer).toEqual({ intro: "x" });
    expect("errorCode" in ok).toBe(false);
  });
});

describe("status, suggestions, conversations", () => {
  it("status reports enabled, the three modes and the questions left today (platform cap from env)", async () => {
    const { db, svc } = setup(GOOD, { deps: { env: { ...ENV, FLO_DAILY_LIMIT_PER_TENANT: "5" } } });
    db.seed.conversation();
    db.seed.message({ conversationId: "c1" });
    db.seed.message({ conversationId: "c1", status: "DECLINED", declineReason: "OUT_OF_SCOPE" });
    const st = await svc.status();
    expect(st.enabled).toBe(true);
    expect(st.modes.map((m) => m.key)).toEqual(["THOROUGH", "BALANCED", "QUICK"]);
    expect(Object.keys(st.modes[0]).sort()).toEqual(["description", "key", "label"]);
    expect(st.dailyRemaining).toBe(4);
    expect(Object.keys(st)).not.toContain("limit");
    const off = await createFloService(db.tp, { env: {} as never, now: () => NOW }).status();
    expect(off.enabled).toBe(false);
  });

  it("suggestions are the groups with questions", () => {
    const { svc } = setup();
    const out = svc.suggestions();
    expect(out.groups[0]).toEqual({ area: "Today", questions: ["What is on today and who is behind?", "Summarise yesterday"] });
    expect(out.groups).toHaveLength(SUGGESTION_GROUPS.length);
  });

  it("lists only the caller's conversations, newest first, with paging", async () => {
    const { db, svc } = setup();
    const a = db.seed.conversation({ title: "A" });
    const b = db.seed.conversation({ title: "B" });
    const c = db.seed.conversation({ title: "C" });
    db.seed.conversation({ profileId: "other-admin", title: "Not mine" });
    const first = await svc.listConversations("p1", { limit: 2 });
    expect(first.conversations.map((x) => x.title)).toEqual(["C", "B"]);
    expect(first.nextCursor).toBe(b.id);
    expect(Object.keys(first.conversations[0]).sort()).toEqual(["id", "title", "updatedAt"]);
    const second = await svc.listConversations("p1", { limit: 2, cursor: first.nextCursor! });
    expect(second.conversations.map((x) => x.title)).toEqual(["A"]);
    expect(second.nextCursor).toBeNull();
    expect((await svc.listConversations("p1")).conversations).toHaveLength(3);
    expect([a.id, c.id]).toHaveLength(2);
  });

  it("returns a conversation with USER text and ASSISTANT final-message messages; another admin's id is 404", async () => {
    const { db, svc } = setup();
    const conv = db.seed.conversation({ title: "Skips" });
    db.seed.message({ conversationId: conv.id, role: "USER", text: "Show skips" });
    db.seed.message({ conversationId: conv.id, text: "You have 2.", answer: { intro: "You have 2." } });
    db.seed.message({ conversationId: conv.id, status: "ERROR", errorCode: "FLO_TIMEOUT" });
    const got = await svc.getConversation("p1", conv.id);
    expect(got).toMatchObject({ id: conv.id, title: "Skips" });
    expect(got.messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT", "ASSISTANT"]);
    expect(got.messages[0]).toMatchObject({ text: "Show skips" });
    expect(got.messages[2]).toMatchObject({ status: "ERROR", errorCode: "FLO_TIMEOUT" });
    await expect(svc.getConversation("someone-else", conv.id)).rejects.toMatchObject({ statusCode: 404, code: "FLO_CONVERSATION_NOT_FOUND" });
    await expect(svc.getConversation("p1", "missing")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("deletes only the caller's own conversation (messages go with it)", async () => {
    const { db, svc } = setup();
    const conv = db.seed.conversation();
    db.seed.message({ conversationId: conv.id });
    await expect(svc.deleteConversation("someone-else", conv.id)).rejects.toMatchObject({ statusCode: 404, code: "FLO_CONVERSATION_NOT_FOUND" });
    expect(db.conversations).toHaveLength(1);
    await svc.deleteConversation("p1", conv.id);
    expect(db.conversations).toHaveLength(0);
    expect(db.messages).toHaveLength(0);
    await expect(svc.deleteConversation("p1", conv.id)).rejects.toBeInstanceOf(FloError);
  });
});

describe("chat: persistence and event order", () => {
  it("streams start..done, creates and titles the conversation, persists user + assistant with audit and usage", async () => {
    const { db, svc } = setup();
    const handle = await chat(svc, { message: "Show the skipped visits this month", mode: "BALANCED" });
    expect(handle).toMatchObject({ replayed: false, messageId: "msg-assistant", mode: "BALANCED" });
    expect(db.conversations).toHaveLength(1);
    expect(db.conversations[0]).toMatchObject({ profileId: "p1", title: "Show the skipped visits this month" });
    expect(db.messages.map((m) => m.role)).toEqual(["USER"]); // persisted before the stream

    const events = await collect(handle);
    expect(events.map((e) => e.event)).toEqual(["start", "status", "status", "text", "block", "text", "follow_ups", "done"]);
    expect(events[0]).toEqual({ event: "start", data: { conversationId: handle.conversationId, messageId: "msg-assistant", mode: "BALANCED" } });
    const done = events[events.length - 1] as { data: { message: FinalMessage } };
    expect(done.data.message).toMatchObject({ id: "msg-assistant", role: "ASSISTANT", status: "OK", mode: "BALANCED", model: "claude-sonnet-5-5", declined: null, warnings: [] });
    expect(done.data.message.answer?.intro).toBe("You have 2 skipped visits.");

    const row = db.messages.find((m) => m.id === "msg-assistant")!;
    expect(row).toMatchObject({ status: "OK", conversationId: handle.conversationId, mode: "BALANCED", inputTokens: 200, outputTokens: 40, cachedTokens: 20 });
    expect(row.text).toBe("You have 2 skipped visits. Round 7 had skips.");
    expect(row.toolCalls).toEqual([expect.objectContaining({ tool: "list_skipped_visits", sourceId: "r1", ok: true, rows: 2 })]);
    expect(typeof row.durationMs).toBe("number");

    // GET returns exactly what `done` carried.
    const again = await svc.getConversation("p1", handle.conversationId);
    expect(again.messages[1]).toEqual(done.data.message);
    expect(again.messages[0]).toMatchObject({ role: "USER", text: "Show the skipped visits this month" });
  });

  it("continues an existing conversation: history is the last 10 turns, assistant turns as final text only", async () => {
    const { db, s, svc } = setup();
    const conv = db.seed.conversation();
    db.seed.message({ conversationId: conv.id, role: "ASSISTANT", text: "Orphan assistant first.", answer: { intro: "Orphan assistant first." } });
    for (let i = 0; i < 6; i++) {
      db.seed.message({ conversationId: conv.id, role: "USER", text: `Question ${i}` });
      db.seed.message({ conversationId: conv.id, role: "ASSISTANT", text: `Answer ${i}`, answer: { intro: `Intro ${i}`, blocks: [{ type: "table", rows: [{ secret: "x" }] }] } });
    }
    db.seed.message({ conversationId: conv.id, status: "ERROR", errorCode: "FLO_TIMEOUT", text: "" });
    db.seed.message({ conversationId: conv.id, status: "DECLINED", declineReason: "OUT_OF_SCOPE", text: "I can only answer..." });
    const handle = await chat(svc, { message: "Compare with September", conversationId: conv.id });
    expect(handle.conversationId).toBe(conv.id);
    expect(db.conversations).toHaveLength(1);
    await collect(handle);

    const sent = s.streamCalls[0].messages;
    expect(sent).toHaveLength(11); // 10 history turns + the new question
    expect(sent.every((m) => typeof m.content === "string")).toBe(true);
    expect(sent[0]).toEqual({ role: "user", content: "Question 1" }); // first of the last 10 rows after the orphan/oldest are cut
    expect(sent[sent.length - 1]).toEqual({ role: "user", content: "Compare with September" });
    expect(JSON.stringify(sent)).not.toContain("secret");
    expect(JSON.stringify(sent)).not.toContain("I can only answer");
    // The classifier got the previous intro line.
    expect(s.classifierCalls[0].messages[0].content).toContain("<previous_answer>Intro 5</previous_answer>");
  });

  it("drops a leading assistant turn so the provider conversation starts with the user", async () => {
    const { db, s, svc } = setup();
    const conv = db.seed.conversation();
    db.seed.message({ conversationId: conv.id, role: "USER", text: "Old question" });
    db.seed.message({ conversationId: conv.id, role: "ASSISTANT", text: "Old answer", answer: {} });
    db.seed.message({ conversationId: conv.id, role: "USER", text: "Second question" });
    db.seed.message({ conversationId: conv.id, role: "ASSISTANT", text: "", answer: {} }); // empty text is skipped
    await collect(await chat(svc, { message: "Next", conversationId: conv.id }));
    // 4 rows fetched (+ the new user row excluded): user, assistant, user -> starts with user.
    expect(s.streamCalls[0].messages.map((m) => m.content)).toEqual(["Old question", "Old answer", "Second question", "Next"]);
    const { db: db2, s: s2, svc: svc2 } = setup();
    const conv2 = db2.seed.conversation();
    db2.seed.message({ conversationId: conv2.id, role: "ASSISTANT", text: "Starts with assistant", answer: { intro: 5 } });
    await collect(await chat(svc2, { message: "Hello again", conversationId: conv2.id }));
    expect(s2.streamCalls[0].messages.map((m) => m.content)).toEqual(["Hello again"]);
    expect(s2.classifierCalls[0].messages[0].content).not.toContain("previous_answer");
  });

  it("a conversation that is not the caller's is 404 and nothing is created", async () => {
    const { db, svc } = setup();
    const theirs = db.seed.conversation({ profileId: "other-admin" });
    await expect(chat(svc, { message: "hi", conversationId: theirs.id })).rejects.toMatchObject({ statusCode: 404, code: "FLO_CONVERSATION_NOT_FOUND" });
    await expect(chat(svc, { message: "hi", conversationId: "nope" })).rejects.toMatchObject({ statusCode: 404 });
    expect(db.messages).toHaveLength(0);
    expect(db.conversations).toHaveLength(1);
  });

  it("is unavailable (503 FLO_UNAVAILABLE) without a key or with the kill switch, before anything is written", async () => {
    const { db, svc } = setup(GOOD, { deps: { env: {} as never } });
    await expect(chat(svc, { message: "hi" })).rejects.toMatchObject({ statusCode: 503, code: "FLO_UNAVAILABLE" });
    const killed = createFloService(db.tp, { env: { ANTHROPIC_API_KEY: "k", FLO_ENABLED: "false" } as never });
    await expect(chat(killed, { message: "hi" })).rejects.toMatchObject({ code: "FLO_UNAVAILABLE" });
    expect(db.conversations).toHaveLength(0);
  });
});

describe("chat: declines, errors and aborts are persisted", () => {
  it("OUT_OF_SCOPE: no main-model call, DECLINED row with the reason, done carries the fixed copy", async () => {
    const { db, s, svc } = setup(GOOD, { verdict: "OUT_OF_SCOPE" });
    const events = await collect(await chat(svc, { message: "What is the capital of France?" }));
    expect(events.map((e) => e.event)).toEqual(["start", "declined", "done"]);
    expect(s.streamCalls).toHaveLength(0);
    const row = db.messages.find((m) => m.id === "msg-assistant")!;
    expect(row).toMatchObject({ status: "DECLINED", declineReason: "OUT_OF_SCOPE", model: null });
    const done = (events[2] as { data: { message: FinalMessage } }).data.message;
    expect(done).toMatchObject({ status: "DECLINED", answer: null, declined: { reason: "OUT_OF_SCOPE" }, model: null });
    expect(done.declined?.suggestions).toHaveLength(3);
  });

  it("CAPABILITY: answered from SUGGESTION_GROUPS with no main-model call, stored as DECLINED / CAPABILITY", async () => {
    const { db, s, svc } = setup(GOOD, { verdict: "CAPABILITY_QUESTION" });
    const events = await collect(await chat(svc, { message: "What can you do?" }));
    expect(s.streamCalls).toHaveLength(0);
    expect(events.map((e) => e.event)).toEqual(["start", "declined", "done"]);
    expect((events[1] as { data: { suggestions: string[] } }).data.suggestions).toEqual(SUGGESTION_GROUPS.map((g) => g.items[0]));
    expect(db.messages.find((m) => m.id === "msg-assistant")).toMatchObject({ status: "DECLINED", declineReason: "CAPABILITY" });
  });

  it("an answer with no tool data becomes the NO_DATA decline and is stored as DECLINED", async () => {
    const { db, svc } = setup([answerTurn("<intro>Paris.</intro>")]);
    const events = await collect(await chat(svc, { message: "Who owes me money?" }));
    expect(events.map((e) => e.event)).toEqual(["start", "declined", "done"]);
    expect(db.messages.find((m) => m.id === "msg-assistant")).toMatchObject({ status: "DECLINED", declineReason: "NO_DATA_USED" });
  });

  it("a provider failure after the stream started is an error event, stored as ERROR with the code (not counted as answered)", async () => {
    const { db, svc } = setup([toolTurn({ id: "t", name: "list_skipped_visits" }), failTurn(new ProviderError("PROVIDER_UNAVAILABLE", "x", 529, true))]);
    const events = await collect(await chat(svc, { message: "Show skips" }));
    expect(events.map((e) => e.event)).toEqual(["start", "status", "status", "error"]);
    expect(events[3]).toEqual({ event: "error", data: { code: "FLO_PROVIDER_ERROR", message: "Flo could not reach its AI service. Try again.", retryable: true } });
    expect(db.messages.find((m) => m.id === "msg-assistant")).toMatchObject({ status: "ERROR", errorCode: "FLO_PROVIDER_ERROR", model: "claude-sonnet-5-5" });
    expect((await createFloService(db.tp, { env: ENV, now: () => NOW }).status()).dailyRemaining).toBe(100);
  });

  it("a client disconnect persists ABORTED, sends no done and is not counted", async () => {
    const { db, svc } = setup([hangTurn]);
    const ac = new AbortController();
    const handle = await chat(svc, { message: "Show skips" });
    const pending = collect(handle, ac.signal);
    await vi.waitFor(() => expect(db.calls).toContain("floMessage.findMany"));
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    const events = await pending;
    expect(events.map((e) => e.event)).toEqual(["start"]);
    expect(db.messages.find((m) => m.id === "msg-assistant")).toMatchObject({ status: "ABORTED", text: "" });
    expect((await svc.status()).dailyRemaining).toBe(100);
  });

  it("a failure loading history or context becomes a stored INTERNAL error, not a crash", async () => {
    const { db, svc } = setup();
    db.failNext.set("floMessage.findMany", new Error("db down"));
    const events = await collect(await chat(svc, { message: "Show skips" }));
    expect(events.map((e) => e.event)).toEqual(["start", "error"]);
    expect(events[1]).toMatchObject({ data: { code: "FLO_INTERNAL_ERROR", retryable: true } });
    expect(db.messages.find((m) => m.id === "msg-assistant")).toMatchObject({ status: "ERROR", errorCode: "FLO_INTERNAL_ERROR" });
    expect(console.error).toHaveBeenCalledWith("[flo] pipeline failed:", "Error");
    db.failNext.set("floMessage.findMany", "not an error object");
    await collect(await chat(svc, { message: "Again" }));
    expect(console.error).toHaveBeenCalledWith("[flo] pipeline failed:", "unknown");
  });

  it("a persistence failure after the answer is an error event and releases the idempotency key", async () => {
    const { db, svc } = setup();
    const handle = await chat(svc, { message: "Show skips" }, { key: "k-persist" });
    expect(db.idempotency).toHaveLength(1);
    db.failNext.set("floConversation.update", new Error("write failed"));
    const events = await collect(handle);
    expect(events[events.length - 1]).toMatchObject({ event: "error", data: { code: "FLO_INTERNAL_ERROR" } });
    expect(events.map((e) => e.event)).not.toContain("done");
    expect(db.idempotency).toHaveLength(0);
    db.failNext.set("floConversation.update", "str");
    await collect(await chat(svc, { message: "Show skips" }));
    expect(console.error).toHaveBeenCalledWith("[flo] failed to persist the answer:", "unknown");
  });
});

describe("caps", () => {
  const ok = (db: FakeFloDb, conv: string, createdAt: Date, over: Record<string, unknown> = {}) => db.seed.message({ conversationId: conv, createdAt, ...over });

  it("daily cap: OK answers of the whole tenant count, the platform env sets the limit, 429 carries resetsAt at tenant midnight", async () => {
    const { db, svc } = setup(GOOD, { deps: { env: { ...ENV, FLO_DAILY_LIMIT_PER_TENANT: "2" } } });
    const conv = db.seed.conversation({ profileId: "someone-else" });
    ok(db, conv.id, new Date("2026-11-10T01:00:00Z"));
    await expect(chat(svc, { message: "hi" })).resolves.toBeTruthy(); // 1 used of 2
    ok(db, conv.id, new Date("2026-11-10T02:00:00Z"));
    const err = await chat(svc, { message: "hi" }).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 429, code: "FLO_DAILY_LIMIT", resetsAt: "2026-11-11T00:00:00.000Z" });
    expect(Object.entries(err).map(([k]) => k)).toContain("resetsAt");
  });

  it("midnight boundary in the tenant's timezone: 23:59 counts today, 00:00 belongs to the next day", async () => {
    // Europe/London in July is UTC+1: the local day 2026-07-15 is [14 Jul 23:00Z, 15 Jul 23:00Z).
    const db = fakeFloDb();
    const conv = db.seed.conversation();
    ok(db, conv.id, new Date("2026-07-14T22:59:59Z")); // previous local day
    ok(db, conv.id, new Date("2026-07-15T22:59:59Z")); // today, last second
    ok(db, conv.id, new Date("2026-07-15T23:00:00Z")); // next local day
    const at = (iso: string) => createFloService(db.tp, { env: { ...ENV, FLO_DAILY_LIMIT_PER_TENANT: "1" }, now: () => new Date(iso) }).status();
    expect((await at("2026-07-15T12:00:00Z")).dailyRemaining).toBe(0);
    expect((await at("2026-07-15T23:00:01Z")).dailyRemaining).toBe(0); // one counted in the new day
    expect((await at("2026-07-16T23:00:00Z")).dailyRemaining).toBe(1); // a day with no answers
  });

  it("ERROR, ABORTED and DECLINED rows never count against the daily cap", async () => {
    const { db, svc } = setup(GOOD, { deps: { env: { ...ENV, FLO_DAILY_LIMIT_PER_TENANT: "1" } } });
    const conv = db.seed.conversation();
    for (const status of ["ERROR", "ABORTED", "DECLINED"]) ok(db, conv.id, NOW, { status });
    await expect(chat(svc, { message: "hi" })).resolves.toBeTruthy();
  });

  it("decline cap: DECLINED rows of THIS admin count, CAPABILITY replies and other admins do not; 429 FLO_DECLINE_LIMIT", async () => {
    const { db, svc } = setup(GOOD, { deps: { env: { ...ENV, FLO_DECLINE_LIMIT_PER_DAY: "2" } } });
    const mine = db.seed.conversation({ profileId: "p1" });
    const theirs = db.seed.conversation({ profileId: "p2" });
    ok(db, theirs.id, NOW, { status: "DECLINED", declineReason: "OUT_OF_SCOPE" });
    ok(db, mine.id, NOW, { status: "DECLINED", declineReason: "CAPABILITY" });
    ok(db, mine.id, new Date("2026-11-09T12:00:00Z"), { status: "DECLINED", declineReason: "OUT_OF_SCOPE" }); // yesterday
    ok(db, mine.id, NOW, { status: "DECLINED", declineReason: "OUT_OF_SCOPE" });
    await expect(chat(svc, { message: "hi" })).resolves.toBeTruthy(); // 1 counted of 2
    ok(db, mine.id, NOW, { status: "DECLINED", declineReason: "UNSAFE" });
    await expect(chat(svc, { message: "hi" })).rejects.toMatchObject({ statusCode: 429, code: "FLO_DECLINE_LIMIT" });
    // A decline does not count towards the DAILY cap.
    expect((await svc.status()).dailyRemaining).toBe(100);
    // The other admin is unaffected.
    await expect(chat(svc, { message: "hi" }, { profileId: "p3" })).resolves.toBeTruthy();
  });

  it("a request that fails a cap releases its idempotency key and writes nothing", async () => {
    const { db, svc } = setup(GOOD, { deps: { env: { ...ENV, FLO_DAILY_LIMIT_PER_TENANT: "1" } } });
    const conv = db.seed.conversation();
    ok(db, conv.id, NOW);
    await expect(chat(svc, { message: "hi" }, { key: "k1" })).rejects.toMatchObject({ code: "FLO_DAILY_LIMIT" });
    expect(db.idempotency).toHaveLength(0);
    expect(db.messages).toHaveLength(1);
  });
});

describe("Idempotency-Key", () => {
  it("replays the stored final message as start + done, without running again or counting twice", async () => {
    const { db, s, svc } = setup();
    const first = await collect(await chat(svc, { message: "Show skips" }, { key: "abc" }));
    const firstDone = first[first.length - 1] as { data: { message: FinalMessage } };
    expect(db.idempotency[0]).toMatchObject({ key: "flo:p1:abc", state: "DONE", responseStatus: 200, actorId: "p1", route: "POST /flo/chat" });

    const handle = await chat(svc, { message: "Show skips" }, { key: "abc" });
    expect(handle.replayed).toBe(true);
    const replay = await collect(handle);
    expect(replay.map((e) => e.event)).toEqual(["start", "done"]);
    expect(replay[0]).toMatchObject({ data: { conversationId: handle.conversationId, messageId: "msg-assistant", mode: "BALANCED" } });
    expect((replay[1] as { data: { message: FinalMessage } }).data.message).toEqual(JSON.parse(JSON.stringify(firstDone.data.message)));
    expect(s.streamCalls).toHaveLength(2); // the first run only: the replay made no provider call
    expect(db.messages.filter((m) => m.role === "USER")).toHaveLength(1);
    expect(db.conversations).toHaveLength(1);
  });

  it("replays a DECLINED answer with its declined event", async () => {
    const { svc } = setup(GOOD, { verdict: "OUT_OF_SCOPE" });
    await collect(await chat(svc, { message: "Capital of France?" }, { key: "d1" }));
    const replay = await collect(await chat(svc, { message: "Capital of France?" }, { key: "d1" }));
    expect(replay.map((e) => e.event)).toEqual(["start", "declined", "done"]);
  });

  it("a replay is not blocked by the daily cap", async () => {
    const { db, svc } = setup(GOOD, { deps: { env: { ...ENV, FLO_DAILY_LIMIT_PER_TENANT: "1" } } });
    await collect(await chat(svc, { message: "Show skips" }, { key: "cap" }));
    expect((await svc.status()).dailyRemaining).toBe(0);
    const handle = await chat(svc, { message: "Show skips" }, { key: "cap" });
    expect(handle.replayed).toBe(true);
    expect(db.messages.filter((m) => m.role === "USER")).toHaveLength(1);
  });

  it("answers 409 FLO_REQUEST_IN_PROGRESS while the first request is still running", async () => {
    const { db, svc } = setup();
    const handle = await chat(svc, { message: "Show skips" }, { key: "busy" });
    await expect(chat(svc, { message: "Show skips" }, { key: "busy" })).rejects.toMatchObject({ statusCode: 409, code: "FLO_REQUEST_IN_PROGRESS" });
    expect(db.idempotency).toHaveLength(1);
    await collect(handle);
  });

  it("takes over a stale IN_PROGRESS key (the first request died)", async () => {
    const { db, svc } = setup();
    db.idempotency.push({ key: "flo:p1:old", actorId: "p1", route: "POST /flo/chat", state: "IN_PROGRESS", createdAt: new Date(Date.now() - IDEMPOTENCY_STALE_MS - 1000) });
    const handle = await chat(svc, { message: "Show skips" }, { key: "old" });
    expect(handle.replayed).toBe(false);
    expect(db.idempotency).toHaveLength(1);
    expect(db.idempotency[0].createdAt.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it("keys are per admin: another admin's identical key is a different request", async () => {
    const { db, svc } = setup();
    await collect(await chat(svc, { message: "Show skips" }, { key: "same" }));
    const other = await chat(svc, { message: "Show skips" }, { key: "same", profileId: "p2" });
    expect(other.replayed).toBe(false);
    expect(db.idempotency.map((r) => r.key).sort()).toEqual(["flo:p1:same", "flo:p2:same"]);
  });

  it("a failed run releases the key so the same request can be retried", async () => {
    const { db, svc } = setup([failTurn(new ProviderError("PROVIDER_UNAVAILABLE", "x", 500, true))]);
    await collect(await chat(svc, { message: "Show skips" }, { key: "retry" }));
    expect(db.idempotency).toHaveLength(0);
    const again = await chat(svc, { message: "Show skips" }, { key: "retry" });
    expect(again.replayed).toBe(false);
  });

  it("an aborted run releases the key", async () => {
    const { db, svc } = setup([hangTurn]);
    const ac = new AbortController();
    ac.abort();
    await collect(await chat(svc, { message: "Show skips" }, { key: "ab" }), ac.signal);
    expect(db.idempotency).toHaveLength(0);
  });

  it("rejects an empty or over-long key with 400 INVALID_IDEMPOTENCY_KEY", async () => {
    const { svc } = setup();
    await expect(chat(svc, { message: "hi" }, { key: "  " })).rejects.toMatchObject({ statusCode: 400, code: "INVALID_IDEMPOTENCY_KEY" });
    await expect(chat(svc, { message: "hi" }, { key: "k".repeat(201) })).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
  });

  it("retries the claim when the row vanished between insert and read, and gives up after three tries", async () => {
    const { db, svc } = setup();
    const orig = db.tp.idempotencyRecord.create;
    let calls = 0;
    (db.tp.idempotencyRecord as { create: unknown }).create = async (a: unknown) => {
      calls++;
      if (calls === 1) throw p2002(); // findUnique finds nothing -> claim again
      return (orig as (x: unknown) => Promise<unknown>)(a);
    };
    expect((await chat(svc, { message: "hi" }, { key: "race" })).replayed).toBe(false);
    expect(calls).toBe(2);

    (db.tp.idempotencyRecord as { create: unknown }).create = async () => {
      throw p2002();
    };
    await expect(chat(svc, { message: "hi" }, { key: "never" })).rejects.toMatchObject({ code: "P2002" });
  });

  it("rethrows a claim error that is not a unique violation", async () => {
    const { db, svc } = setup();
    db.failNext.set("idempotencyRecord.create", new Error("connection lost"));
    await expect(chat(svc, { message: "hi" }, { key: "x" })).rejects.toThrow("connection lost");
  });

  it("logs and carries on when the key cannot be stored or released", async () => {
    const { db, svc } = setup();
    const handle = await chat(svc, { message: "Show skips" }, { key: "store-fails" });
    db.failNext.set("idempotencyRecord.update", new Error("x"));
    db.failNext.set("idempotencyRecord.deleteMany", new Error("y"));
    const events = await collect(handle);
    expect(events[events.length - 1].event).toBe("done");
    expect(console.error).toHaveBeenCalledWith("[flo] failed to store idempotent response:", "Error");
    expect(console.error).toHaveBeenCalledWith("[flo] failed to release idempotency key:", "Error");

    db.failNext.set("idempotencyRecord.update", "str");
    db.failNext.set("idempotencyRecord.deleteMany", "str");
    await collect(await chat(svc, { message: "Show skips" }, { key: "store-fails-2" }));
    expect(console.error).toHaveBeenCalledWith("[flo] failed to store idempotent response:", "unknown");
    expect(console.error).toHaveBeenCalledWith("[flo] failed to release idempotency key:", "unknown");
  });
});
