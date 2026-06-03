import { triggerStore } from './trigger-store';

interface HydratedTrigger {
  id: number;
  ownerId: string;
  guildId?: string | null;
  channelId?: string | null;
  skillId?: number | null;
  type: string;
  label?: string | null;
  instruction: string;
  speakers: string;
  cooldownSeconds?: number | null;
  oneShot: boolean;
  phrases: string[];
  patterns: RegExp[];
  lastFiredAt: Date | null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPattern(raw: string): RegExp {
  return new RegExp(`(?:^|\\W)${escapeRegex(raw)}(?:\\W|$)`, 'i');
}

class PhraseTriggerRegistry {
  private items: HydratedTrigger[] = [];
  private fireTimes: number[] = [];
  private static MAX_PER_MINUTE = 30;

  load(items: HydratedTrigger[]): void {
    this.items = items;
  }

  async loadFromDb(): Promise<void> {
    const rows = await triggerStore.loadActivePhrase();
    this.items = rows.map((r: any) => ({
      id: r.id,
      ownerId: r.ownerId,
      guildId: r.guildId,
      channelId: r.channelId,
      skillId: r.skillId,
      type: r.type,
      label: r.label,
      instruction: r.instruction,
      speakers: r.speakers ?? 'anyone',
      cooldownSeconds: r.cooldownSeconds,
      oneShot: r.oneShot ?? false,
      phrases: r.phrases ?? [],
      patterns: (r.phrases ?? []).map((p: string) => buildPattern(p)),
      lastFiredAt: r.lastFiredAt ? new Date(r.lastFiredAt) : null,
    }));
    console.log(`[phrase-registry] Loaded ${this.items.length} active phrase triggers`);
  }

  add(row: any): void {
    const item: HydratedTrigger = {
      id: row.id,
      ownerId: row.ownerId,
      guildId: row.guildId,
      channelId: row.channelId,
      skillId: row.skillId,
      type: row.type,
      label: row.label,
      instruction: row.instruction,
      speakers: row.speakers ?? 'anyone',
      cooldownSeconds: row.cooldownSeconds,
      oneShot: row.oneShot ?? false,
      phrases: row.phrases ?? [],
      patterns: (row.phrases ?? []).map((p: string) => buildPattern(p)),
      lastFiredAt: row.lastFiredAt ? new Date(row.lastFiredAt) : null,
    };
    this.items.push(item);
  }

  remove(id: number): void {
    this.items = this.items.filter(t => t.id !== id);
  }

  update(row: any): void {
    this.remove(row.id);
    this.add(row);
  }

  touch(id: number): void {
    const now = new Date();
    const t = this.items.find(i => i.id === id);
    if (t) t.lastFiredAt = now;
    void triggerStore.touchFired(id, now);
  }

  get activeCount(): number {
    return this.items.length;
  }

  match(text: string, isOwner: boolean): HydratedTrigger[] {
    const now = Date.now();
    this.fireTimes = this.fireTimes.filter(t => now - t < 60_000);

    if (this.fireTimes.length >= PhraseTriggerRegistry.MAX_PER_MINUTE) {
      console.warn(`[phrase-registry] Rate limit reached (${PhraseTriggerRegistry.MAX_PER_MINUTE}/min), skipping match`);
      return [];
    }

    const norm = text.toLowerCase();
    const out: HydratedTrigger[] = [];

    for (const t of this.items) {
      if (t.speakers === 'owner' && !isOwner) continue;

      const hit = t.patterns.some(p => p.test(norm));
      if (!hit) continue;

      const cd = (t.cooldownSeconds ?? 0) * 1000;
      if (t.lastFiredAt && now - t.lastFiredAt.getTime() < cd) continue;

      out.push(t);
    }

    if (out.length > 0) {
      this.fireTimes.push(now);
    }
    return out;
  }
}

export const phraseTriggerRegistry = new PhraseTriggerRegistry();