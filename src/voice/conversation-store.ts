import { prisma } from '../db';
import { config } from '../config';

export interface StoredChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ConversationRow {
  id: number;
  ownerId: string;
  role: string;
  content: string | null;
  toolCalls: string | null;
  toolCallId: string | null;
}

function rowToMessage(row: ConversationRow): StoredChatMessage {
  const msg: StoredChatMessage = {
    role: row.role as StoredChatMessage['role'],
    content: row.content,
  };
  if (row.toolCalls) {
    try {
      msg.tool_calls = JSON.parse(row.toolCalls);
    } catch {
      // corrupt payload — drop tool_calls
    }
  }
  if (row.toolCallId) {
    msg.tool_call_id = row.toolCallId;
  }
  return msg;
}

function messageToRowData(ownerId: string, msg: StoredChatMessage) {
  return {
    ownerId,
    role: msg.role,
    content: msg.content,
    toolCalls: msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
    toolCallId: msg.tool_call_id ?? null,
  };
}

export const conversationStore = {
  async loadHistory(ownerId: string): Promise<StoredChatMessage[]> {
    const rows = await (prisma as any).conversationMessage.findMany({
      where: { ownerId },
      orderBy: { id: 'asc' },
    });
    return rows.map(rowToMessage);
  },

  async appendMessages(ownerId: string, messages: StoredChatMessage[]): Promise<void> {
    if (messages.length === 0) return;

    const persistable = messages.filter((m) => m.role !== 'system');
    if (persistable.length === 0) return;

    await (prisma as any).conversationMessage.createMany({
      data: persistable.map((m) => messageToRowData(ownerId, m)),
    });

    await this.trim(ownerId);
  },

  async clearHistory(ownerId: string): Promise<void> {
    await (prisma as any).conversationMessage.deleteMany({
      where: { ownerId },
    });
  },

  async trim(ownerId: string): Promise<void> {
    const max = config.llmMaxHistory;
    const count = await (prisma as any).conversationMessage.count({
      where: { ownerId },
    });
    if (count <= max) return;

    const excess = count - max;
    // Delete the oldest `excess` rows by id.
    const oldest = await (prisma as any).conversationMessage.findMany({
      where: { ownerId },
      orderBy: { id: 'asc' },
      take: excess,
      select: { id: true },
    });
    if (oldest.length === 0) return;
    const ids = oldest.map((r: { id: number }) => r.id);
    await (prisma as any).conversationMessage.deleteMany({
      where: { id: { in: ids } },
    });
  },
};
