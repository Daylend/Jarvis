import { prisma } from '../db';
import seedData from '../bdo-terms.seed.json';

class Normalizer {
  private regex: RegExp | null = null;
  private mapping = new Map<string, string>(); // alias.toLowerCase() -> canonical
  private loaded = false;

  async load(): Promise<void> {
    await this.seedFromJson();
    const rows = await prisma.termAlias.findMany();
    this.rebuild(rows);
    this.loaded = true;
    console.log(`[normalizer] Loaded ${rows.length} term aliases.`);
  }

  private async seedFromJson(): Promise<void> {
    console.log('[normalizer] Seeding BDO term aliases from bdo-terms.seed.json...');
    const entries = Object.entries(seedData) as [string, string[]][];
    for (const [canonical, aliases] of entries) {
      for (const alias of aliases) {
        await prisma.termAlias.upsert({
          where: { canonical_alias: { canonical, alias } },
          create: { canonical, alias },
          update: {},
        });
      }
    }
    console.log('[normalizer] Seed complete.');
  }

  private rebuild(rows: { canonical: string; alias: string }[]): void {
    this.mapping.clear();
    const escaped: string[] = [];
    for (const r of rows) {
      this.mapping.set(r.alias.toLowerCase(), r.canonical);
      escaped.push(r.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    this.regex =
      escaped.length > 0
        ? new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi')
        : null;
  }

  /** Reload aliases from DB (call after /terms mutations). */
  async invalidate(): Promise<void> {
    const rows = await prisma.termAlias.findMany();
    this.rebuild(rows);
    console.log(`[normalizer] Reloaded ${rows.length} term aliases.`);
  }

  apply(text: string): string {
    if (!this.loaded || !this.regex) return text;
    return text.replace(this.regex, (m) => this.mapping.get(m.toLowerCase()) ?? m);
  }
}

export const normalizer = new Normalizer();
