import { describe, expect, it } from "vitest";
import type { FloEvent } from "../answer";
import { createFloService } from "../flo.service";
import { fakeFloDb, skip } from "./fake-flo-db";
import { answerTurn, scripted, toolTurn } from "./orchestrator.helpers";

// Two tenants with different data (plan 3.3 item 3). A chat as tenant A never contains tenant B rows, including when the
// model asks for an id that belongs to B: ids are resolved through A's client and are not found. Per-admin scoping of
// conversations is tested at the end.

const NOW = new Date("2026-11-10T12:00:00.000Z");
const ENV = { ANTHROPIC_API_KEY: "test-key" } as unknown as NodeJS.ProcessEnv;

function tenant(name: string, round: string) {
  const db = fakeFloDb();
  db.rounds = [round];
  db.visits = [{ ...skip("2026-11-05", `Reason for ${name}`, `Round of ${name}`), property: { addressLine: `1 ${name} Street`, customer: { name: `Mrs ${name}` } } }];
  return db;
}

async function ask(db: ReturnType<typeof tenant>, toolInput: unknown, profileId = "p1") {
  const s = scripted([
    toolTurn({ id: "t", name: "list_skipped_visits", input: toolInput }),
    answerTurn('<intro>Checked your skipped visits.</intro><block>{"type":"table","sourceId":"r1","columns":["customer","reason"]}</block>'),
  ]);
  const svc = createFloService(db.tp, { provider: s.provider, env: ENV, now: () => NOW });
  const handle = await svc.prepare({ profileId, body: { message: "Show skipped visits" } });
  const events: FloEvent[] = [];
  for await (const e of handle.events(new AbortController().signal)) events.push(e);
  const everything = JSON.stringify({ events, provider: [...s.classifierCalls, ...s.streamCalls], rows: [db.messages, db.conversations] });
  return { events, everything, s, svc, handle };
}

describe("two-tenant isolation", () => {
  it("tenant A's chat contains only A's rows, and B's contains only B's", async () => {
    const a = tenant("Alpha", "round-a");
    const b = tenant("Beta", "round-b");
    const ra = await ask(a, {});
    const rb = await ask(b, {});
    expect(ra.everything).toContain("Mrs Alpha");
    expect(ra.everything).not.toContain("Beta");
    expect(rb.everything).toContain("Mrs Beta");
    expect(rb.everything).not.toContain("Alpha");
  });

  it("an id that belongs to B, requested while chatting as A, is not found and returns no rows", async () => {
    const a = tenant("Alpha", "round-a");
    tenant("Beta", "round-b");
    const r = await ask(a, { roundId: "round-b" });
    expect(r.events.map((e) => e.event)).toEqual(["start", "status", "status", "declined", "done"]); // the tool failed, so nothing to show
    expect(r.everything).toContain("Round not found");
    expect(r.everything).not.toContain("Mrs Alpha");
    const back = r.s.streamCalls[1].messages[2].content as Array<{ is_error?: boolean }>;
    expect(back[0].is_error).toBe(true);
  });

  it("B's conversation id cannot be read, continued or deleted through A's service", async () => {
    const a = tenant("Alpha", "round-a");
    const b = tenant("Beta", "round-b");
    const theirs = b.seed.conversation({ profileId: "p1" });
    const svcA = createFloService(a.tp, { env: ENV, now: () => NOW });
    await expect(svcA.getConversation("p1", theirs.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svcA.deleteConversation("p1", theirs.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svcA.prepare({ profileId: "p1", body: { message: "hi", conversationId: theirs.id } })).rejects.toMatchObject({ code: "FLO_CONVERSATION_NOT_FOUND" });
    expect(b.conversations).toHaveLength(1);
  });

  it("the daily cap is per tenant: B's answers do not use up A's allowance", async () => {
    const a = tenant("Alpha", "round-a");
    const b = tenant("Beta", "round-b");
    const conv = b.seed.conversation();
    for (let i = 0; i < 5; i++) b.seed.message({ conversationId: conv.id, createdAt: new Date("2026-11-10T08:00:00Z") });
    const env = { ...ENV, FLO_DAILY_LIMIT_PER_TENANT: "5" } as NodeJS.ProcessEnv;
    expect((await createFloService(a.tp, { env, now: () => NOW }).status()).dailyRemaining).toBe(5);
    expect((await createFloService(b.tp, { env, now: () => NOW }).status()).dailyRemaining).toBe(0);
  });
});

describe("per-admin scoping within one tenant", () => {
  it("another admin's conversation is 404 for reads, writes and listing", async () => {
    const db = tenant("Alpha", "round-a");
    const mine = db.seed.conversation({ profileId: "admin-1", title: "Mine" });
    const theirs = db.seed.conversation({ profileId: "admin-2", title: "Theirs" });
    const svc = createFloService(db.tp, { env: ENV, now: () => NOW });
    await expect(svc.getConversation("admin-1", theirs.id)).rejects.toMatchObject({ statusCode: 404, code: "FLO_CONVERSATION_NOT_FOUND" });
    await expect(svc.deleteConversation("admin-1", theirs.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.prepare({ profileId: "admin-1", body: { message: "hi", conversationId: theirs.id } })).rejects.toMatchObject({ statusCode: 404 });
    expect((await svc.listConversations("admin-1")).conversations.map((c) => c.id)).toEqual([mine.id]);
  });
});
