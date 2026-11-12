import { Prisma } from "../../../generated/tenant-client";
import type { TenantPrismaClient } from "../../../lib/tenant-prisma-manager";

// An in-memory tenant client for the Flo service, SSE, route and guardrail tests. It implements only what Flo reads and
// writes: floConversation, floMessage, idempotencyRecord, businessSettings, plus the visit/round reads the
// list_skipped_visits tool makes. No real database, ever. Any other model or method throws, so an unexpected write fails.

export interface Row {
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface FakeFloDb {
  tp: TenantPrismaClient;
  conversations: Row[];
  messages: Row[];
  idempotency: Row[];
  /** Calls by "model.method" (for "no main-model write happened" style assertions). */
  calls: string[];
  /** Fail the next call of "model.method" with this error (once). */
  failNext: Map<string, unknown>;
  timezone: string;
  visits: Row[];
  /** Round ids that exist in this tenant. */
  rounds: string[];
  /** Extra BusinessSettings columns (the secrets canary). */
  settingsExtra: Row;
  clock: () => Date;
  seed: {
    conversation(over?: Row): Row;
    message(over: Row): Row;
  };
}

function compare(value: any, cond: any, db: FakeFloDb, row: Row): boolean { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
    return Object.entries(cond).every(([op, v]) => {
      if (op === "gte") return value >= (v as Date);
      if (op === "lt") return value < (v as Date);
      if (op === "not") return value !== v;
      return false;
    });
  }
  return value === cond;
}

function matches(row: Row, where: Row | undefined, db: FakeFloDb): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Row[]).some((w) => matches(row, w, db));
    if (key === "conversation") {
      const conv = db.conversations.find((c) => c.id === row.conversationId);
      return !!conv && matches(conv, cond as Row, db);
    }
    return compare(row[key], cond, db, row);
  });
}

function pick(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

export function p2002(): Error {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
}

export function fakeFloDb(opts: { timezone?: string; start?: string } = {}): FakeFloDb {
  let seq = 0;
  let tick = new Date(opts.start ?? "2026-11-10T09:00:00.000Z").getTime();
  const db: FakeFloDb = {
    tp: undefined as unknown as TenantPrismaClient,
    conversations: [],
    messages: [],
    idempotency: [],
    calls: [],
    failNext: new Map(),
    timezone: opts.timezone ?? "Europe/London",
    visits: [],
    rounds: ["round-7"],
    settingsExtra: {},
    clock: () => new Date((tick += 1)),
    seed: {
      conversation: (over = {}) => {
        const c = { id: `c${++seq}`, profileId: "p1", title: "Seeded", createdAt: db.clock(), updatedAt: db.clock(), ...over };
        db.conversations.push(c);
        return c;
      },
      message: (over) => {
        const m = {
          id: `m${++seq}`, role: "ASSISTANT", mode: "BALANCED", model: "claude-sonnet-5-5", text: "", answer: null, toolCalls: null, warnings: [],
          inputTokens: null, outputTokens: null, cachedTokens: null, durationMs: null, status: "OK", declineReason: null, errorCode: null,
          createdAt: db.clock(), ...over,
        };
        db.messages.push(m);
        return m;
      },
    },
  };

  const guard = (path: string) => {
    db.calls.push(path);
    const err = db.failNext.get(path);
    if (err !== undefined) {
      db.failNext.delete(path);
      throw err;
    }
  };

  const floConversation = {
    async findFirst(a: Row) {
      guard("floConversation.findFirst");
      const c = db.conversations.find((r) => matches(r, a.where, db));
      if (!c) return null;
      return { ...pick(c, a.select), ...(a.select?.messages ? { messages: db.messages.filter((m) => m.conversationId === c.id).sort((x, y) => +x.createdAt - +y.createdAt) } : {}) };
    },
    async create(a: Row) {
      guard("floConversation.create");
      const c = { id: `c${++seq}`, createdAt: db.clock(), updatedAt: db.clock(), ...a.data };
      db.conversations.push(c);
      return pick(c, a.select);
    },
    async update(a: Row) {
      guard("floConversation.update");
      const c = db.conversations.find((r) => r.id === a.where.id);
      Object.assign(c as Row, a.data);
      return c;
    },
    async findMany(a: Row) {
      guard("floConversation.findMany");
      let rows = db.conversations.filter((r) => matches(r, a.where, db)).sort((x, y) => +y.updatedAt - +x.updatedAt || (y.id < x.id ? -1 : 1));
      if (a.cursor) rows = rows.slice(rows.findIndex((r) => r.id === a.cursor.id) + (a.skip ?? 0));
      return rows.slice(0, a.take).map((r) => pick(r, a.select));
    },
    async deleteMany(a: Row) {
      guard("floConversation.deleteMany");
      const gone = db.conversations.filter((r) => matches(r, a.where, db));
      db.conversations = db.conversations.filter((r) => !gone.includes(r));
      db.messages = db.messages.filter((m) => !gone.some((c) => c.id === m.conversationId));
      return { count: gone.length };
    },
  };

  const floMessage = {
    async create(a: Row) {
      guard("floMessage.create");
      const m = {
        text: "", answer: null, toolCalls: null, warnings: [], mode: null, model: null, status: "OK", declineReason: null, errorCode: null,
        inputTokens: null, outputTokens: null, cachedTokens: null, durationMs: null, createdAt: db.clock(), id: `m${++seq}`, ...a.data,
      };
      db.messages.push(m);
      return pick(m, a.select);
    },
    async findMany(a: Row) {
      guard("floMessage.findMany");
      const rows = db.messages.filter((r) => matches(r, a.where, db)).sort((x, y) => +y.createdAt - +x.createdAt);
      return rows.slice(0, a.take).map((r) => pick(r, a.select));
    },
    async count(a: Row) {
      guard("floMessage.count");
      return db.messages.filter((r) => matches(r, a.where, db)).length;
    },
  };

  const idempotencyRecord = {
    async create(a: Row) {
      guard("idempotencyRecord.create");
      if (db.idempotency.some((r) => r.key === a.data.key)) throw p2002();
      db.idempotency.push({ createdAt: new Date(), responseStatus: null, responseBody: null, ...a.data });
    },
    async findUnique(a: Row) {
      guard("idempotencyRecord.findUnique");
      return db.idempotency.find((r) => r.key === a.where.key) ?? null;
    },
    async update(a: Row) {
      guard("idempotencyRecord.update");
      Object.assign(db.idempotency.find((r) => r.key === a.where.key) as Row, a.data);
    },
    async deleteMany(a: Row) {
      guard("idempotencyRecord.deleteMany");
      const w = a.where as Row;
      db.idempotency = db.idempotency.filter(
        (r) => !(r.key === w.key && (w.state === undefined || r.state === w.state) && (w.createdAt === undefined || r.createdAt < w.createdAt.lt))
      );
    },
  };

  const businessSettings = {
    async findFirst() {
      return { timezone: db.timezone, currency: "gbp", defaultWorkingDays: [], businessName: "Test Windows", ...db.settingsExtra };
    },
  };

  // The one tool the service tests run for real (list_skipped_visits).
  const visit = {
    async findMany() {
      return db.visits;
    },
    async count() {
      return db.visits.length;
    },
  };
  const round = {
    async findUnique(a: Row) {
      return db.rounds.includes(a.where.id) ? { id: a.where.id } : null;
    },
  };

  const models: Record<string, unknown> = { floConversation, floMessage, idempotencyRecord, businessSettings, visit, round };
  db.tp = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return undefined;
      if (!(prop in models)) throw new Error(`Unexpected model access: ${prop}`);
      return models[prop];
    },
  }) as unknown as TenantPrismaClient;
  return db;
}

export const skip = (date: string, reason: string, round = "Round 7") => ({
  date: new Date(`${date}T00:00:00Z`),
  skipReason: reason,
  round: { name: round },
  technician: { name: "Liam" },
  property: { addressLine: "12 Oak Road", customer: { name: "Mrs Smith" } },
});
