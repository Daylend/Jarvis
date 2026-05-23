import { prisma } from '../db';

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

export interface SearchFilter {
  guildId: string;
  query: string;
  userId?: string;
  sessionId?: string;
  after?: Date;
  before?: Date;
  limit?: number;
}

export interface GetTranscriptsFilter {
  guildId: string;
  aroundId?: number;
  aroundTime?: Date;
  sessionId?: string;
  userId?: string;
  after?: Date;
  before?: Date;
  limit?: number;
}

function buildWhere(opts: {
  guildId: string;
  userId?: string;
  sessionId?: string;
  after?: Date;
  before?: Date;
}): Record<string, unknown> {
  const w: any = { guildId: opts.guildId };
  if (opts.userId) w.userId = opts.userId;
  if (opts.sessionId) w.sessionId = opts.sessionId;
  if (opts.after || opts.before) {
    w.createdAt = {};
    if (opts.after) w.createdAt.gte = opts.after;
    if (opts.before) w.createdAt.lte = opts.before;
  }
  return w;
}

export const transcriptStore = {
  async save(seg: AsrSegmentRow): Promise<void> {
    await (prisma as any).transcript.create({ data: seg });
  },

  async search(filter: SearchFilter): Promise<any[]> {
    const limit = Math.min(filter.limit || 10, 50);
    const where = {
      ...buildWhere({
        guildId: filter.guildId,
        userId: filter.userId,
        sessionId: filter.sessionId,
        after: filter.after,
        before: filter.before,
      }),
      textNormalized: { contains: filter.query },
    };
    return (prisma as any).transcript.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  },

  async getTranscripts(filter: GetTranscriptsFilter): Promise<any[]> {
    const limit = Math.min(filter.limit || 10, 200);
    const baseWhere = buildWhere({
      guildId: filter.guildId,
      userId: filter.userId,
      sessionId: filter.sessionId,
      after: filter.after,
      before: filter.before,
    });

    if (filter.aroundId !== undefined) {
      const anchor = await (prisma as any).transcript.findUnique({
        where: { id: filter.aroundId },
      });
      if (!anchor || anchor.guildId !== filter.guildId) return [];

      const half = Math.ceil(limit / 2);

      const before = await (prisma as any).transcript.findMany({
        where: { ...baseWhere, id: { lte: filter.aroundId } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: half,
      });

      const after = await (prisma as any).transcript.findMany({
        where: { ...baseWhere, id: { gt: filter.aroundId } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: half,
      });

      return [...before.reverse(), ...after];
    }

    if (filter.aroundTime) {
      const half = Math.ceil(limit / 2);

      const beforeAndAnchor = await (prisma as any).transcript.findMany({
        where: {
          ...baseWhere,
          createdAt: { lte: filter.aroundTime },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: half,
      });

      const after = await (prisma as any).transcript.findMany({
        where: {
          ...baseWhere,
          createdAt: { gt: filter.aroundTime },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: half,
      });

      return [...beforeAndAnchor.reverse(), ...after];
    }

    const rows = await (prisma as any).transcript.findMany({
      where: baseWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.reverse();
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
};