import { prisma } from '../db';
import type { AsrSegment } from './types';

interface AsrSegmentRow {
  sessionId: string;
  guildId: string;
  channelId: string;
  userId: string;
  startMs: number;
  endMs: number;
  textRaw: string;
  textNormalized: string;
  confidence?: number | null;
}

export const transcriptStore = {
  async save(seg: AsrSegmentRow): Promise<void> {
    await (prisma as any).transcript.create({ data: seg });
  },

  /** Last N finalized segments from the most recent session in this guild, optionally filtered by userId. */
  async recent(guildId: string, count: number, userId?: string): Promise<any[]> {
    const session = await (prisma as any).voiceSession.findFirst({
      where: { guildId },
      orderBy: { startedAt: 'desc' },
    });
    if (!session) return [];
    return (prisma as any).transcript.findMany({
      where: {
        sessionId: session.id,
        ...(userId ? { userId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: count,
    });
  },

  /** Full transcript of a session (by id or most recent in guild). */
  async session(
    sessionId?: string,
    guildId?: string,
  ): Promise<{ session: any | null; rows: any[] }> {
    const s = sessionId
      ? await (prisma as any).voiceSession.findUnique({ where: { id: sessionId } })
      : await (prisma as any).voiceSession.findFirst({
          where: { guildId },
          orderBy: { startedAt: 'desc' },
        });
    if (!s) return { session: null, rows: [] };
    const rows = await (prisma as any).transcript.findMany({
      where: { sessionId: s.id },
      orderBy: { startMs: 'asc' },
    });
    return { session: s, rows };
  },

  /** Case-insensitive substring search over textNormalized in a guild. */
  async search(guildId: string, q: string, limit = 25): Promise<any[]> {
    return (prisma as any).transcript.findMany({
      where: {
        guildId,
        textNormalized: { contains: q },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  /** All transcripts in a channel within the last `sinceMs` milliseconds. */
  async contextWindow(guildId: string, channelId: string, sinceMs: number): Promise<any[]> {
    return (prisma as any).transcript.findMany({
      where: {
        guildId,
        channelId,
        createdAt: { gte: new Date(Date.now() - sinceMs) },
      },
      orderBy: { createdAt: 'asc' },
    });
  },

  /** List recent voice sessions in a guild, newest first, with transcript counts. */
  async listSessions(guildId: string, limit = 10): Promise<any[]> {
    return (prisma as any).voiceSession.findMany({
      where: { guildId },
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: {
        _count: { select: { transcripts: true } },
      },
    });
  },

  /** Get transcript lines around a specific offset within a session. */
  async aroundOffset(
    sessionId: string,
    centerMs: number,
    windowMs: number,
  ): Promise<any[]> {
    return (prisma as any).transcript.findMany({
      where: {
        sessionId,
        startMs: {
          gte: Math.max(0, centerMs - windowMs),
          lte: centerMs + windowMs,
        },
      },
      orderBy: { startMs: 'asc' },
    });
  },

  /**
   * Get transcript for a session with optional time-range filtering.
   * If no sessionId is provided, uses the most recent session in the guild.
   */
  async sessionFiltered(
    guildId: string,
    sessionId?: string,
    startOffsetMs?: number,
    endOffsetMs?: number,
    limit = 100,
  ): Promise<{ session: any | null; rows: any[] }> {
    const s = sessionId
      ? await (prisma as any).voiceSession.findUnique({ where: { id: sessionId } })
      : await (prisma as any).voiceSession.findFirst({
          where: { guildId },
          orderBy: { startedAt: 'desc' },
        });
    if (!s) return { session: null, rows: [] };

    const where: any = { sessionId: s.id };
    if (startOffsetMs !== undefined || endOffsetMs !== undefined) {
      where.startMs = {};
      if (startOffsetMs !== undefined) where.startMs.gte = startOffsetMs;
      if (endOffsetMs !== undefined) where.startMs.lte = endOffsetMs;
    }

    const rows = await (prisma as any).transcript.findMany({
      where,
      orderBy: { startMs: 'asc' },
      take: limit,
    });
    return { session: s, rows };
  },
};
