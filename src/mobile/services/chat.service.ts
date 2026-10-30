import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import type { ChatMessageRow } from "../types";

// senderProfileId stores the public Profile id (D-4). Rows written before that
// fix hold the sender's Supabase user id, so `isMine` matches either.
export interface ChatViewer {
  profileId: string;
  supabaseUserId: string;
}

class ChatService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  async getChatMessages(roundId: string, viewer: ChatViewer, since?: Date): Promise<ChatMessageRow[]> {
    const rows = await this.prisma.chatMessage.findMany({
      where: { roundId, ...(since ? { createdAt: { gt: since } } : {}) },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => ({
      ...r,
      isMine: r.senderProfileId === viewer.profileId || r.senderProfileId === viewer.supabaseUserId,
    }));
  }

  async sendChatMessage(roundId: string, senderProfileId: string, body: string): Promise<ChatMessageRow> {
    const row = await this.prisma.chatMessage.create({ data: { roundId, senderProfileId, body, type: "TEXT" } });
    return { ...row, isMine: true };
  }

  async sendWorkPhotosMessage(roundId: string, senderProfileId: string, visitId: string): Promise<ChatMessageRow> {
    const row = await this.prisma.chatMessage.create({ data: { roundId, senderProfileId, type: "WORK_PHOTOS", visitId } });
    return { ...row, isMine: true };
  }

  async sendPhotosMessage(roundId: string, senderProfileId: string, photoUrls: string[], body?: string): Promise<ChatMessageRow> {
    const row = await this.prisma.chatMessage.create({ data: { roundId, senderProfileId, type: "PHOTOS", photoUrls, body: body ?? null } });
    return { ...row, isMine: true };
  }
}

export function createChatService(prisma: TenantPrismaClient) {
  return new ChatService(prisma);
}
