import { prisma } from '../db';

export const noteStore = {
  async save(guildId: string, title: string, content: string): Promise<{ id: number }> {
    return (prisma as any).note.create({
      data: { guildId, title, content },
      select: { id: true },
    });
  },

  async getTitles(guildId: string): Promise<Array<{ id: number; title: string }>> {
    return (prisma as any).note.findMany({
      where: { guildId },
      select: { id: true, title: true },
      orderBy: { createdAt: 'desc' },
    });
  },

  async getById(id: number, guildId: string): Promise<any | null> {
    return (prisma as any).note.findFirst({
      where: { id, guildId },
    });
  },

  async search(guildId: string, query?: string, limit = 10): Promise<any[]> {
    const take = Math.min(limit, 50);
    if (query) {
      return (prisma as any).note.findMany({
        where: {
          guildId,
          OR: [
            { title: { contains: query } },
            { content: { contains: query } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take,
      });
    }
    return (prisma as any).note.findMany({
      where: { guildId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },

  async delete(id: number, guildId: string): Promise<boolean> {
    const note = await (prisma as any).note.findFirst({
      where: { id, guildId },
    });
    if (!note) return false;
    await (prisma as any).note.delete({ where: { id } });
    return true;
  },
};
