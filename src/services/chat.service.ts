import { Prisma, VisitStatus } from "../generated/tenant-client";
import type { ChatSenderRole } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { prisma as publicPrisma } from "../lib/prisma";
import { createNotificationService } from "../mobile/services/notification.service";

// Round chat between the office and the technicians on a round (one thread per
// round). Shared by the admin API (/chat/*) and the technician app
// (/mobile/chat/*). Polling-based: clients ask for `since` / `before` pages and
// unread counts; there is no push channel other than the notification row +
// best-effort device push created for the technicians on an office message.

export const CHAT_TEXT_MAX = 2000;
export const CHAT_DEFAULT_LIMIT = 100;
export const CHAT_MAX_LIMIT = 200;
export const CHAT_CLIENT_MSG_ID_MAX = 100;
export const CHAT_MAX_PHOTOS = 10;

export type ChatMessageType = "TEXT" | "WORK_PHOTOS" | "PHOTOS";

export interface ChatRow {
  id: string;
  roundId: string;
  senderProfileId: string;
  senderRole: ChatSenderRole;
  body: string | null;
  type: string;
  visitId: string | null;
  photoUrls: string[];
  clientMsgId: string | null;
  createdAt: Date;
  isMine: boolean;
}

// senderProfileId stores the public Profile id (D-4). Rows written before that
// fix hold the sender's Supabase user id, so `isMine` matches either.
export interface ChatViewer {
  profileId: string;
  supabaseUserId?: string;
}

export interface ChatListOptions {
  since?: Date;
  before?: Date;
  limit?: number;
}

export interface ChatSendInput {
  type: ChatMessageType;
  text?: string | null;
  visitId?: string | null;
  photoUrls?: string[];
  clientMsgId?: string | null;
}

const viewerIds = (v: ChatViewer): string[] => [v.profileId, ...(v.supabaseUserId ? [v.supabaseUserId] : [])];

// ---- request parsing (shared by both routers) ------------------------------

function parseDate(v: unknown, field: string): Date | undefined {
  if (v === undefined || v === "") return undefined;
  const d = new Date(String(v));
  if (typeof v !== "string" || Number.isNaN(d.getTime())) throw new AppError(400, `${field} must be a valid ISO date`);
  return d;
}

export function parseChatListQuery(query: Record<string, unknown>): ChatListOptions {
  const since = parseDate(query.since, "since");
  const before = parseDate(query.before, "before");
  if (since && before) throw new AppError(400, "Send either since or before, not both");
  let limit = CHAT_DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const n = Number(query.limit);
    if (typeof query.limit !== "string" || !Number.isInteger(n) || n < 1) {
      throw new AppError(400, "limit must be a positive integer");
    }
    limit = Math.min(n, CHAT_MAX_LIMIT);
  }
  return { since, before, limit };
}

/** Trimmed, non-empty message text of at most 2000 characters. */
export function parseChatText(v: unknown, field = "text"): string {
  if (typeof v !== "string" || v.trim() === "") throw new AppError(400, `${field} is required`);
  const text = v.trim();
  if (text.length > CHAT_TEXT_MAX) {
    throw new AppError(400, `${field} must be at most ${CHAT_TEXT_MAX} characters`, "CHAT_TEXT_TOO_LONG");
  }
  return text;
}

export function parseClientMsgId(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > CHAT_CLIENT_MSG_ID_MAX) {
    throw new AppError(400, `clientMsgId must be a string of at most ${CHAT_CLIENT_MSG_ID_MAX} characters`);
  }
  return v;
}

/** Photo urls must be storage paths this tenant uploaded for this round's chat. */
export function assertChatPhotoUrls(photoUrls: string[], tenantId: string, roundId: string): void {
  if (photoUrls.length > CHAT_MAX_PHOTOS) throw new AppError(400, `photoUrls may hold at most ${CHAT_MAX_PHOTOS} items`);
  const prefix = `${tenantId}/chat/${roundId}/`;
  if (photoUrls.some((u) => typeof u !== "string" || !u.startsWith(prefix) || u.includes(".."))) {
    throw new AppError(
      400,
      "photoUrls must be storage paths returned by this round's chat attachment upload-url",
      "INVALID_PHOTO_URL"
    );
  }
}

// ---- core -------------------------------------------------------------------

export function createChatCore(tp: TenantPrismaClient) {
  return {
    /** `since` -> oldest first from that point (poll for new); otherwise the
     *  newest `limit` messages (older than `before` when given). Always
     *  returned oldest first. hasMore = more rows exist in the direction read. */
    async listMessages(
      roundId: string,
      viewer: ChatViewer,
      opts: ChatListOptions = {}
    ): Promise<{ rows: ChatRow[]; hasMore: boolean }> {
      const limit = opts.limit ?? CHAT_DEFAULT_LIMIT;
      const createdAt: Prisma.DateTimeFilter = {};
      if (opts.since) createdAt.gt = opts.since;
      if (opts.before) createdAt.lt = opts.before;
      const forward = !!opts.since;
      const found = await tp.chatMessage.findMany({
        where: { roundId, ...(opts.since || opts.before ? { createdAt } : {}) },
        orderBy: forward ? [{ createdAt: "asc" }, { id: "asc" }] : [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const hasMore = found.length > limit;
      const page = hasMore ? found.slice(0, limit) : found;
      const ordered = forward ? page : [...page].reverse();
      const mine = new Set(viewerIds(viewer));
      return { rows: ordered.map((r) => ({ ...r, isMine: mine.has(r.senderProfileId) })), hasMore };
    },

    /** Creates a message, or returns the existing one for a repeated clientMsgId. */
    async send(
      roundId: string,
      sender: { profileId: string; role: ChatSenderRole },
      input: ChatSendInput
    ): Promise<{ row: ChatRow; duplicate: boolean }> {
      const clientMsgId = input.clientMsgId ?? null;
      const existingWhere = { roundId, senderProfileId: sender.profileId, clientMsgId: clientMsgId as string };
      const asRow = (r: Omit<ChatRow, "isMine">): ChatRow => ({ ...r, isMine: true });
      if (clientMsgId) {
        const existing = await tp.chatMessage.findFirst({ where: existingWhere });
        if (existing) return { row: asRow(existing), duplicate: true };
      }
      try {
        const row = await tp.chatMessage.create({
          data: {
            roundId,
            senderProfileId: sender.profileId,
            senderRole: sender.role,
            type: input.type,
            body: input.text ?? null,
            visitId: input.visitId ?? null,
            photoUrls: input.photoUrls ?? [],
            clientMsgId,
          },
        });
        return { row: asRow(row), duplicate: false };
      } catch (err) {
        // Two concurrent sends with the same clientMsgId: the loser reads the winner's row.
        if (clientMsgId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          const existing = await tp.chatMessage.findFirst({ where: existingWhere });
          if (existing) return { row: asRow(existing), duplicate: true };
        }
        throw err;
      }
    },

    async markRead(viewer: ChatViewer, roundId: string, at: Date = new Date()): Promise<{ roundId: string; lastReadAt: Date }> {
      await tp.chatRead.upsert({
        where: { profileId_roundId: { profileId: viewer.profileId, roundId } },
        create: { profileId: viewer.profileId, roundId, lastReadAt: at },
        update: { lastReadAt: at },
      });
      return { roundId, lastReadAt: at };
    },

    /** Messages from other senders newer than the viewer's read marker, per round. */
    async unreadByRound(viewer: ChatViewer, roundIds: string[]): Promise<Map<string, number>> {
      const result = new Map<string, number>();
      if (roundIds.length === 0) return result;
      const reads = await tp.chatRead.findMany({ where: { profileId: viewer.profileId, roundId: { in: roundIds } } });
      const lastRead = new Map(reads.map((r) => [r.roundId, r.lastReadAt]));
      await Promise.all(
        roundIds.map(async (roundId) => {
          const readAt = lastRead.get(roundId);
          result.set(
            roundId,
            await tp.chatMessage.count({
              where: {
                roundId,
                senderProfileId: { notIn: viewerIds(viewer) },
                ...(readAt ? { createdAt: { gt: readAt } } : {}),
              },
            })
          );
        })
      );
      return result;
    },
  };
}

// ---- office (admin) side ------------------------------------------------------

export interface ChatThread {
  roundId: string;
  roundName: string;
  technicians: Array<{ id: string; name: string | null; active: boolean }>;
  lastMessage: { id: string; type: string; body: string | null; senderRole: ChatSenderRole; senderProfileId: string; createdAt: Date } | null;
  unreadCount: number;
}

export function createChatAdminService(tp: TenantPrismaClient) {
  const core = createChatCore(tp);

  const assertRound = async (roundId: string) => {
    const round = await tp.round.findUnique({ where: { id: roundId }, select: { id: true } });
    if (!round) throw new AppError(404, "Round not found");
  };

  // Cross-schema lookup (Profile lives in the public schema), as in reports.getActivity.
  const nameMap = async (profileIds: string[]): Promise<Map<string, string>> => {
    const ids = [...new Set(profileIds)];
    if (ids.length === 0) return new Map();
    const profiles = await publicPrisma.profile.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(profiles.map((p) => [p.id, p.name]));
  };

  // Technicians who should hear about an office message: the round's active,
  // signed-up technicians plus anyone holding an open visit on it.
  const recipientProfileIds = async (roundId: string, today: Date): Promise<string[]> => {
    const [members, holders] = await Promise.all([
      tp.roundTechnician.findMany({
        where: { roundId, technician: { active: true, profileId: { not: null } } },
        select: { technician: { select: { profileId: true } } },
      }),
      tp.visit.findMany({
        where: {
          roundId,
          date: { gte: today },
          status: { in: [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS] },
          technician: { active: true, profileId: { not: null } },
        },
        select: { technician: { select: { profileId: true } } },
        distinct: ["technicianId"],
      }),
    ]);
    return [
      ...new Set([...members, ...holders].map((r) => r.technician?.profileId).filter((id): id is string => !!id)),
    ];
  };

  return {
    async listThreads(viewer: ChatViewer): Promise<{ threads: ChatThread[] }> {
      const grouped = await tp.chatMessage.groupBy({ by: ["roundId"], _max: { createdAt: true } });
      if (grouped.length === 0) return { threads: [] };
      const roundIds = grouped.map((g) => g.roundId);

      const [rounds, recent, unread] = await Promise.all([
        tp.round.findMany({
          where: { id: { in: roundIds } },
          select: {
            id: true,
            name: true,
            roundTechnicians: { select: { technician: { select: { id: true, name: true, active: true } } } },
          },
        }),
        tp.chatMessage.findMany({
          where: { roundId: { in: roundIds } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          distinct: ["roundId"],
        }),
        core.unreadByRound(viewer, roundIds),
      ]);
      const roundById = new Map(rounds.map((r) => [r.id, r]));
      const lastByRound = new Map(recent.map((m) => [m.roundId, m]));

      const threads = roundIds
        .map((roundId): ChatThread | null => {
          const round = roundById.get(roundId);
          if (!round) return null; // round deleted since: nothing to open
          const last = lastByRound.get(roundId) ?? null;
          return {
            roundId,
            roundName: round.name,
            technicians: round.roundTechnicians.map((rt) => rt.technician),
            lastMessage: last && {
              id: last.id,
              type: last.type,
              body: last.body,
              senderRole: last.senderRole,
              senderProfileId: last.senderProfileId,
              createdAt: last.createdAt,
            },
            unreadCount: unread.get(roundId) ?? 0,
          };
        })
        .filter((t): t is ChatThread => t !== null)
        .sort((a, b) => (b.lastMessage?.createdAt.getTime() ?? 0) - (a.lastMessage?.createdAt.getTime() ?? 0));
      return { threads };
    },

    async listMessages(roundId: string, viewer: ChatViewer, opts: ChatListOptions) {
      await assertRound(roundId);
      const { rows, hasMore } = await core.listMessages(roundId, viewer, opts);
      const names = await nameMap(rows.map((r) => r.senderProfileId));
      return { messages: rows.map((r) => ({ ...r, senderName: names.get(r.senderProfileId) ?? null })), hasMore };
    },

    async send(
      roundId: string,
      sender: { profileId: string; name?: string | null },
      input: { text?: string | null; photoUrls?: string[]; clientMsgId?: string | null },
      today: Date
    ) {
      await assertRound(roundId);
      const photoUrls = input.photoUrls ?? [];
      const { row, duplicate } = await core.send(roundId, { profileId: sender.profileId, role: "OFFICE" }, {
        type: photoUrls.length > 0 ? "PHOTOS" : "TEXT",
        text: input.text ?? null,
        photoUrls,
        clientMsgId: input.clientMsgId,
      });
      if (!duplicate) await this.notifyTechnicians(roundId, input.text ?? "Sent you photos", today);
      return { message: { ...row, senderName: sender.name ?? null }, duplicate };
    },

    // Never fails the send: a missing push setup or a notification error is logged only.
    async notifyTechnicians(roundId: string, text: string, today: Date): Promise<number> {
      try {
        const profileIds = await recipientProfileIds(roundId, today);
        const notifications = createNotificationService(tp);
        const preview = text.length > 120 ? `${text.slice(0, 117)}...` : text;
        const results = await Promise.allSettled(
          profileIds.map((id) => notifications.create(id, "CHAT", "New message from the office", preview))
        );
        for (const r of results) if (r.status === "rejected") console.error("[chat] notify failed:", r.reason);
        return results.filter((r) => r.status === "fulfilled").length;
      } catch (err) {
        console.error("[chat] notify failed:", err);
        return 0;
      }
    },

    async markRead(roundId: string, viewer: ChatViewer) {
      await assertRound(roundId);
      return core.markRead(viewer, roundId);
    },

    async unreadCount(viewer: ChatViewer): Promise<{ total: number; rounds: Array<{ roundId: string; unread: number }> }> {
      const grouped = await tp.chatMessage.groupBy({ by: ["roundId"] });
      const unread = await core.unreadByRound(viewer, grouped.map((g) => g.roundId));
      const rounds = [...unread.entries()].filter(([, n]) => n > 0).map(([roundId, n]) => ({ roundId, unread: n }));
      return { total: rounds.reduce((s, r) => s + r.unread, 0), rounds };
    },
  };
}
