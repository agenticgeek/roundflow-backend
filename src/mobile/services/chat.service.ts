import type { TenantPrismaClient } from "../../lib/tenant-prisma-manager";
import type { ChatMessageRow } from "../types";

class ChatService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  async getChatMessages(roundId: string, since?: Date): Promise<ChatMessageRow[]> {
    return this.prisma.chatMessage.findMany({
      where: { roundId, ...(since ? { createdAt: { gt: since } } : {}) },
      orderBy: { createdAt: "asc" },
    });
  }

  async sendChatMessage(roundId: string, senderProfileId: string, body: string): Promise<ChatMessageRow> {
    return this.prisma.chatMessage.create({ data: { roundId, senderProfileId, body, type: "TEXT" } });
  }

  async sendWorkPhotosMessage(roundId: string, senderProfileId: string, visitId: string): Promise<ChatMessageRow> {
    return this.prisma.chatMessage.create({ data: { roundId, senderProfileId, type: "WORK_PHOTOS", visitId } });
  }
}

export function createChatService(prisma: TenantPrismaClient) {
  return new ChatService(prisma);
}
