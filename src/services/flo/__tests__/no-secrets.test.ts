import { describe, expect, it } from "vitest";
import type { FloEvent } from "../answer";
import { createFloService } from "../flo.service";
import { fakeFloDb, skip } from "./fake-flo-db";
import { answerTurn, scripted, toolTurn } from "./orchestrator.helpers";

// No-secrets canary (plan 3.3 item 5 / D5). Secrets are seeded into the tenant's settings (the only place a secret lives
// in this fake). NONE of them may reach the provider wrapper (classifier or main model), the SSE stream, or a stored row.

const NOW = new Date("2026-11-10T12:00:00.000Z");
const ENV = { ANTHROPIC_API_KEY: "sk-ant-PLATFORM-KEY-CANARY" } as unknown as NodeJS.ProcessEnv;

const CANARIES = [
  "CANARY-STRIPE-ACCESS-TOKEN",
  "CANARY-GHL-ACCESS-TOKEN",
  "CANARY-GHL-REFRESH-TOKEN",
  "CANARY-GOCARDLESS-TOKEN",
  "CANARY-WEBHOOK-SECRET",
  "CANARY-SORT-CODE-112233",
  "CANARY-ACCOUNT-NUMBER-99887766",
  "CANARY-API-KEY",
  "CANARY-PASSWORD",
  "sk-ant-PLATFORM-KEY-CANARY",
];

describe("secrets never reach the provider, the stream or storage", () => {
  it("a full chat with canary secrets in the tenant settings leaks none of them", async () => {
    const db = fakeFloDb();
    db.visits = [skip("2026-11-05", "No access")];
    db.settingsExtra = {
      stripeAccessToken: CANARIES[0],
      ghlAccessToken: CANARIES[1],
      ghlRefreshToken: CANARIES[2],
      gocardlessAccessToken: CANARIES[3],
      webhookSecret: CANARIES[4],
      bankDetails: { sortCode: CANARIES[5], accountNumber: CANARIES[6] },
      apiKey: CANARIES[7],
      password: CANARIES[8],
      vatRegistration: "GB123",
    };
    const s = scripted([
      toolTurn({ id: "t", name: "list_skipped_visits" }),
      answerTurn('<intro>You have 1 skipped visit.</intro><block>{"type":"table","sourceId":"r1","columns":["date","reason"]}</block>'),
    ]);
    const svc = createFloService(db.tp, { provider: s.provider, env: ENV, now: () => NOW });
    const handle = await svc.prepare({ profileId: "p1", body: { message: "Show the skipped visits this month" } });
    const events: FloEvent[] = [];
    for await (const e of handle.events(new AbortController().signal)) events.push(e);
    expect(events[events.length - 1].event).toBe("done");

    // Everything the provider wrapper was handed: the classifier call and every main-model call, in full.
    const toProvider = JSON.stringify([...s.classifierCalls, ...s.streamCalls]);
    expect(toProvider).toContain("Test Windows"); // the business name IS sent (D5): proves the settings were read
    expect(s.classifierCalls.length + s.streamCalls.length).toBe(3);
    for (const canary of CANARIES) {
      expect(toProvider, canary).not.toContain(canary);
      expect(JSON.stringify(events), canary).not.toContain(canary);
      expect(JSON.stringify([db.messages, db.conversations]), canary).not.toContain(canary);
    }
    // The key is used by the wrapper only; it is not part of any request the service builds.
    expect(JSON.stringify(s.streamCalls.map((c) => Object.keys(c).sort()))).not.toContain("apiKey");
  });

  it("the classifier only ever receives the question (and the previous intro), never tool data or settings", async () => {
    const db = fakeFloDb();
    db.visits = [skip("2026-11-05", "No access")];
    db.settingsExtra = { stripeAccessToken: CANARIES[0] };
    const s = scripted([toolTurn({ id: "t", name: "list_skipped_visits" }), answerTurn("<intro>You have 1 skipped visit.</intro>")]);
    const svc = createFloService(db.tp, { provider: s.provider, env: ENV, now: () => NOW });
    const handle = await svc.prepare({ profileId: "p1", body: { message: "Show the skipped visits" } });
    for await (const e of handle.events(new AbortController().signal)) void e;
    expect(s.classifierCalls).toHaveLength(1);
    expect(s.classifierCalls[0].tools).toBeUndefined();
    expect(JSON.stringify(s.classifierCalls[0].messages)).toBe(JSON.stringify([{ role: "user", content: "<question>Show the skipped visits</question>" }]));
    expect(s.classifierCalls[0].system).not.toContain("Mrs Smith");
  });
});
