import { Prisma } from "../generated/tenant-client";

// Minimal in-memory stand-in for the tenant client's chat-related models, just
// enough surface for services/chat.service.ts (ordering, since/before, take,
// distinct, groupBy, unique clientMsgId, read markers). One instance = one
// tenant schema, so a second instance models another tenant.

type Row = Record<string, any>;

export function makeChatTenant(seed: { rounds?: Row[]; roundTechnicians?: Row[]; visits?: Row[] } = {}) {
  let seq = 0;
  let clock = Date.parse("2020-01-01T09:00:00Z");
  const messages: Row[] = [];
  const reads: Row[] = [];
  const rounds: Row[] = seed.rounds ?? [{ id: "r1", name: "Alnwick Mon" }];
  const roundTechnicians: Row[] = seed.roundTechnicians ?? [];
  const visits: Row[] = seed.visits ?? [];

  const matchDate = (d: Date, f?: { gt?: Date; lt?: Date }) => !f || ((!f.gt || d > f.gt) && (!f.lt || d < f.lt));
  const matchMsg = (m: Row, where: Row = {}): boolean => {
    if (where.roundId !== undefined) {
      if (typeof where.roundId === "string" ? m.roundId !== where.roundId : !where.roundId.in.includes(m.roundId)) return false;
    }
    if (where.senderProfileId !== undefined) {
      const f = where.senderProfileId;
      if (typeof f === "string" ? m.senderProfileId !== f : f.notIn && f.notIn.includes(m.senderProfileId)) return false;
    }
    if (where.clientMsgId !== undefined && m.clientMsgId !== where.clientMsgId) return false;
    return matchDate(m.createdAt, where.createdAt);
  };
  const sortBy = (rows: Row[], orderBy: Array<Record<string, "asc" | "desc">>) =>
    [...rows].sort((a, b) => {
      for (const o of orderBy) {
        const [k, dir] = Object.entries(o)[0];
        const av = a[k] instanceof Date ? a[k].getTime() : a[k];
        const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
        if (av !== bv) return (av < bv ? -1 : 1) * (dir === "asc" ? 1 : -1);
      }
      return 0;
    });

  const tp: any = {
    round: {
      findUnique: async ({ where }: any) => rounds.find((r) => r.id === where.id) ?? null,
      findMany: async ({ where }: any) =>
        rounds
          .filter((r) => where.id.in.includes(r.id))
          .map((r) => ({ ...r, roundTechnicians: roundTechnicians.filter((rt) => rt.roundId === r.id).map((rt) => ({ technician: rt.technician })) })),
    },
    roundTechnician: {
      findMany: async ({ where }: any) =>
        roundTechnicians
          .filter((rt) => (where.roundId ? rt.roundId === where.roundId : true) && (where.technicianId ? rt.technicianId === where.technicianId : true))
          .map((rt) => ({ roundId: rt.roundId, technician: rt.technician })),
    },
    visit: {
      findMany: async ({ where }: any) => visits.filter((v) => (where.roundId?.not === null ? v.roundId : v.roundId === where.roundId) && (!where.technicianId || v.technicianId === where.technicianId)),
    },
    chatMessage: {
      create: async ({ data }: any) => {
        if (data.clientMsgId && messages.some((m) => m.roundId === data.roundId && m.senderProfileId === data.senderProfileId && m.clientMsgId === data.clientMsgId)) {
          throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "x" });
        }
        const row = { id: `m${++seq}`, senderRole: "TECHNICIAN", clientMsgId: null, visitId: null, body: null, photoUrls: [], ...data, createdAt: new Date((clock = Math.max(clock + 1000, Date.now()))) };
        messages.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => messages.find((m) => matchMsg(m, where)) ?? null,
      findMany: async ({ where, orderBy, take, distinct }: any) => {
        let rows = sortBy(messages.filter((m) => matchMsg(m, where)), orderBy ?? [{ createdAt: "asc" }]);
        if (distinct) {
          const seen = new Set<string>();
          rows = rows.filter((r) => (seen.has(r.roundId) ? false : (seen.add(r.roundId), true)));
        }
        return take ? rows.slice(0, take) : rows;
      },
      count: async ({ where }: any) => messages.filter((m) => matchMsg(m, where)).length,
      groupBy: async () => {
        const by = new Map<string, Date>();
        for (const m of messages) if (!by.has(m.roundId) || by.get(m.roundId)! < m.createdAt) by.set(m.roundId, m.createdAt);
        return [...by.entries()].map(([roundId, createdAt]) => ({ roundId, _max: { createdAt } }));
      },
    },
    chatRead: {
      upsert: async ({ where, create, update }: any) => {
        const { profileId, roundId } = where.profileId_roundId;
        const existing = reads.find((r) => r.profileId === profileId && r.roundId === roundId);
        if (existing) Object.assign(existing, update);
        else reads.push({ ...create });
        return existing ?? create;
      },
      findMany: async ({ where }: any) =>
        reads.filter((r) => r.profileId === where.profileId && where.roundId.in.includes(r.roundId)),
    },
    notification: { create: async ({ data }: any) => ({ id: `n${++seq}`, ...data }) },
  };
  return { tp, messages, reads, lastTs: () => clock };
}
