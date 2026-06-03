import { prisma } from '../db';

const T = () => (prisma as any).trigger;

function hydrate(row: any): any {
  if (!row) return row;
  let parsedPhrases: string[] = [];
  if (row.phrases) {
    try { parsedPhrases = JSON.parse(row.phrases); } catch { parsedPhrases = []; }
  }
  return { ...row, phrases: parsedPhrases };
}

export const triggerStore = {
  async create(data: {
    ownerId: string; guildId?: string | null; channelId?: string | null;
    skillId?: number | null; type: 'time' | 'phrase'; label?: string | null;
    instruction: string;
    fireAt?: Date | null; repeatSeconds?: number | null;
    phrases?: string[] | null; speakers?: 'anyone' | 'owner'; cooldownSeconds?: number | null;
    oneShot?: boolean;
  }) {
    return hydrate(await T().create({
      data: {
        ...data,
        phrases: data.phrases ? JSON.stringify(data.phrases) : null,
      },
    }));
  },

  async getById(id: number): Promise<any | null> {
    return hydrate(await T().findUnique({ where: { id } }));
  },

  async findByLabel(ownerId: string, label: string): Promise<any | null> {
    return hydrate(await T().findFirst({
      where: { ownerId, label, status: 'active' },
    }));
  },

  async listActive({ ownerId, type }: { ownerId: string; type?: string }): Promise<any[]> {
    const where: any = { status: 'active', enabled: true, ownerId };
    if (type) where.type = type;
    const rows = await T().findMany({ where, orderBy: { fireAt: 'asc' } });
    return rows.map(hydrate);
  },

  async listBySkill(skillId: number): Promise<any[]> {
    const rows = await T().findMany({ where: { skillId, status: 'active' } });
    return rows.map(hydrate);
  },

  async loadAllActive(): Promise<any[]> {
    const rows = await T().findMany({
      where: { type: 'time', status: 'active', enabled: true },
    });
    return rows.map(hydrate);
  },

  async loadActivePhrase(): Promise<any[]> {
    const rows = await T().findMany({
      where: { type: 'phrase', status: 'active', enabled: true },
    });
    return rows.map(hydrate);
  },

  async markFired(id: number, at: Date): Promise<void> {
    await T().update({ where: { id }, data: { status: 'fired', lastFiredAt: at } });
  },

  async touchFired(id: number, at: Date): Promise<void> {
    await T().update({ where: { id }, data: { lastFiredAt: at } });
  },

  async reschedule(id: number, nextFireAt: Date): Promise<void> {
    await T().update({
      where: { id },
      data: { fireAt: nextFireAt, lastFiredAt: new Date() },
    });
  },

  async cancel(id: number): Promise<void> {
    await T().update({ where: { id }, data: { status: 'canceled' } });
  },

  async cancelBySkill(skillId: number): Promise<number[]> {
    const rows = await T().findMany({
      where: { skillId, status: 'active' },
      select: { id: true },
    });
    await T().updateMany({
      where: { skillId, status: 'active' },
      data: { status: 'canceled' },
    });
    return rows.map((r: any) => r.id);
  },
};