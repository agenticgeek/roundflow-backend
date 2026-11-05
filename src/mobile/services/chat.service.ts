import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import { VisitStatus } from "../../generated/tenant-client";
import type { ChatMessageRow } from "../types";
import {
  createChatCore,
  type ChatListOptions,
  type ChatSendInput,
  type ChatViewer,
} from "../../services/chat.service";

export type { ChatViewer };

// Technician side of the round chat. The logic lives in services/chat.service.ts
// (shared with the office API); this adds the technician-specific pieces: rows
// are always sent as senderRole TECHNICIAN and unread counts cover the rounds
// the technician is on (assigned to, or holding a recent visit).

const RECENT_VISIT_DAYS = 30;

class ChatService {
  private readonly core;

  constructor(private readonly prisma: TenantPrismaClient) {
    this.core = createChatCore(prisma);
  }

  async getChatMessages(
    roundId: string,
    viewer: ChatViewer,
    since?: Date,
    opts: Omit<ChatListOptions, "since"> = {}
  ): Promise<ChatMessageRow[]> {
    return (await this.core.listMessages(roundId, viewer, { ...opts, since })).rows;
  }

  async send(
    roundId: string,
    senderProfileId: string,
    input: ChatSendInput
  ): Promise<{ row: ChatMessageRow; duplicate: boolean }> {
    return this.core.send(roundId, { profileId: senderProfileId, role: "TECHNICIAN" }, input);
  }

  async markRead(roundId: string, viewer: ChatViewer) {
    return this.core.markRead(viewer, roundId);
  }

  // Rounds the technician can chat in: RoundTechnician rows plus rounds with a
  // visit in the last 30 days (a one-day reassignment counts, like assertRoundMember).
  private async memberRoundIds(technicianId: string, now: Date): Promise<string[]> {
    const since = new Date(now.getTime() - RECENT_VISIT_DAYS * 86_400_000);
    const [assigned, visits] = await Promise.all([
      this.prisma.roundTechnician.findMany({ where: { technicianId }, select: { roundId: true } }),
      this.prisma.visit.findMany({
        where: { technicianId, roundId: { not: null }, date: { gte: since }, status: { not: VisitStatus.CANCELLED } },
        select: { roundId: true },
        distinct: ["roundId"],
      }),
    ]);
    return [...new Set([...assigned.map((a) => a.roundId), ...visits.map((v) => v.roundId as string)])];
  }

  async unread(
    technicianId: string,
    viewer: ChatViewer,
    roundId?: string,
    now: Date = new Date()
  ): Promise<{ total: number; rounds: Array<{ roundId: string; unread: number }> }> {
    const roundIds = roundId ? [roundId] : await this.memberRoundIds(technicianId, now);
    const counts = await this.core.unreadByRound(viewer, roundIds);
    const rounds = [...counts.entries()].filter(([, n]) => n > 0).map(([id, unread]) => ({ roundId: id, unread }));
    return { total: rounds.reduce((s, r) => s + r.unread, 0), rounds };
  }
}

export function createChatService(prisma: TenantPrismaClient) {
  return new ChatService(prisma);
}
