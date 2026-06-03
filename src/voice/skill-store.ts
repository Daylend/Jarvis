import { prisma } from '../db';

const S = () => (prisma as any).skill;

export const skillStore = {
  async save(data: {
    ownerId: string; guildId?: string | null; name: string;
    description: string; playbook: string; autoStart?: boolean;
  }): Promise<any> {
    const existing = await S().findFirst({
      where: { ownerId: data.ownerId, name: data.name },
    });
    if (existing) {
      return S().update({
        where: { id: existing.id },
        data: {
          description: data.description,
          playbook: data.playbook,
          guildId: data.guildId ?? existing.guildId,
          autoStart: data.autoStart ?? existing.autoStart,
        },
      });
    }
    return S().create({ data: { ...data, autoStart: data.autoStart ?? false } });
  },

  async getByName(ownerId: string, name: string): Promise<any | null> {
    return S().findFirst({ where: { ownerId, name } });
  },

  async getById(id: number): Promise<any | null> {
    return S().findUnique({ where: { id } });
  },

  async list(ownerId: string): Promise<any[]> {
    return S().findMany({ where: { ownerId }, orderBy: { name: 'asc' } });
  },

  async setActive(id: number, active: boolean): Promise<void> {
    await S().update({ where: { id }, data: { active } });
  },

  async summaries(ownerId: string): Promise<Array<{ name: string; description: string; active: boolean }>> {
    return S().findMany({
      where: { ownerId },
      select: { name: true, description: true, active: true },
      orderBy: { name: 'asc' },
    });
  },

  async delete(id: number): Promise<boolean> {
    const skill = await S().findUnique({ where: { id } });
    if (!skill) return false;
    await S().delete({ where: { id } });
    return true;
  },
};