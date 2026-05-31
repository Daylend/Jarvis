import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';
import axios from 'axios';
import { config, JARVIS_PROMPT_SCAFFOLD_HEADER, JARVIS_PROMPT_SCAFFOLD_FOOTER } from '../config';

const personalitySchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  voice: z.string().min(1),
  speed: z.number().min(0.5).max(2.0).default(1.0),
  persona: z.string().min(1).transform((s) => s.trim()),
  examples: z.string().default('').transform((s) => s.trim()),
});

interface Personality {
  id: string;
  name: string;
  description: string;
  voice: string;
  speed: number;
  persona: string;
  examples: string;
}

class PersonalityStore {
  private personalities = new Map<string, Personality>();
  private activeId: string | null = null;
  private lastAppliedVoice: string | null = null;
  private lastAppliedSpeed: number | null = null;

  getActiveId(): string | null {
    return this.activeId;
  }

  getActive(): Personality | undefined {
    if (!this.activeId) return undefined;
    return this.personalities.get(this.activeId);
  }

  list(): (Personality & { active: boolean })[] {
    const result: (Personality & { active: boolean })[] = [];
    for (const [, p] of this.personalities) {
      result.push({ ...p, active: p.id === this.activeId });
    }
    result.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
    return result;
  }

  getActivePrompt(): string {
    const p = this.getActive();
    if (!p) return config.jarvisSystemPrompt;

    const name = p.name || 'Jarvis';
    const header = JARVIS_PROMPT_SCAFFOLD_HEADER.replace('{{NAME}}', name);
    const parts: string[] = [header, p.persona];
    if (p.examples) parts.push(p.examples);
    parts.push(JARVIS_PROMPT_SCAFFOLD_FOOTER);
    return parts.join('\n\n');
  }

  private load(): { loaded: number; skipped: number } {
    const dir = config.personalitiesDir;
    let loaded = 0;
    let skipped = 0;

    if (!fs.existsSync(dir)) {
      console.error(`[personality-store] Personalities dir not found: ${dir}`);
      return { loaded, skipped };
    }

    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!/\.ya?ml$/i.test(entry)) continue;

      const filePath = path.join(dir, entry);
      const id = path.basename(entry, path.extname(entry)).toLowerCase();

      try {
        const raw = yaml.load(fs.readFileSync(filePath, 'utf-8'));
        const parsed = personalitySchema.safeParse(raw);

        if (!parsed.success) {
          console.error(
            `[personality-store] Skipping "${entry}": ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
          );
          skipped++;
          continue;
        }

        this.personalities.set(id, { id, ...parsed.data });
        loaded++;
      } catch (err) {
        console.error(`[personality-store] Skipping "${entry}": ${(err as Error).message}`);
        skipped++;
      }
    }

    console.log(`[personality-store] Loaded ${loaded} personalities, skipped ${skipped}`);
    return { loaded, skipped };
  }

  private readState(): string | null {
    try {
      const raw = fs.readFileSync(config.personalityStatePath, 'utf-8');
      const data = JSON.parse(raw);
      if (typeof data.activeId === 'string' && data.activeId.length > 0) {
        return data.activeId;
      }
    } catch {
      // missing or corrupt — ignore
    }
    return null;
  }

  private writeState(): void {
    try {
      const dir = path.dirname(config.personalityStatePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(config.personalityStatePath, JSON.stringify({ activeId: this.activeId }));
    } catch (err) {
      console.error(`[personality-store] Failed to write state: ${(err as Error).message}`);
    }
  }

  private resolveActiveId(): string {
    if (this.personalities.size === 0) {
      throw new Error('No personalities loaded');
    }

    const saved = this.readState();
    if (saved && this.personalities.has(saved)) {
      return saved;
    }
    if (this.personalities.has(config.defaultPersonality)) {
      return config.defaultPersonality;
    }
    return this.personalities.keys().next().value!;
  }

  async init(): Promise<void> {
    this.load();
    if (this.personalities.size === 0) {
      console.error('[personality-store] No personalities loaded, prompts will fall back to env default');
      return;
    }

    this.activeId = this.resolveActiveId();
    this.writeState();

    const p = this.getActive();
    console.log(`[personality-store] Active personality: "${p?.name}" (${this.activeId})`);
    await this.applyToTts();
  }

  async setActive(id: string): Promise<void> {
    if (!this.personalities.has(id)) {
      throw new Error(`Personality "${id}" not found`);
    }
    this.activeId = id;
    this.writeState();

    const p = this.getActive();
    console.log(`[personality-store] Set active: "${p?.name}" (${id})`);
    await this.applyToTts();
  }

  async reload(): Promise<{ loaded: number; skipped: number }> {
    const result = this.load();

    if (this.activeId && !this.personalities.has(this.activeId)) {
      console.warn(`[personality-store] Active personality "${this.activeId}" removed during reload, falling back`);
      this.activeId = this.resolveActiveId();
      this.writeState();
      this.lastAppliedVoice = null;
      this.lastAppliedSpeed = null;
    }

    if (this.activeId) {
      await this.applyToTts();
    }

    return result;
  }

  private async applyToTts(): Promise<void> {
    const p = this.getActive();
    if (!p) return;

    if (p.speed !== this.lastAppliedSpeed) {
      try {
        await axios.post(
          `${config.ttsUrl}/speed`,
          { speed: p.speed },
          { headers: { 'Content-Type': 'application/json' }, timeout: 5_000 },
        );
        this.lastAppliedSpeed = p.speed;
        console.log(`[personality-store] Applied speed: ${p.speed}x`);
      } catch (err) {
        console.warn(`[personality-store] Failed to apply speed: ${(err as Error).message}`);
      }
    }

    if (p.voice !== this.lastAppliedVoice) {
      try {
        await axios.post(
          `${config.ttsUrl}/voice`,
          { name: p.voice },
          { headers: { 'Content-Type': 'application/json' }, timeout: 120_000 },
        );
        this.lastAppliedVoice = p.voice;
        console.log(`[personality-store] Applied voice: ${p.voice}`);
      } catch (err) {
        console.warn(`[personality-store] Failed to apply voice: ${(err as Error).message}`);
      }
    }
  }

  getApplyStatus(): { voice: string; speed: number; voiceOk: boolean; speedOk: boolean } {
    const p = this.getActive();
    return {
      voice: p?.voice ?? '',
      speed: p?.speed ?? 1.0,
      voiceOk: p?.voice === this.lastAppliedVoice,
      speedOk: p?.speed === this.lastAppliedSpeed,
    };
  }
}

export const personalityStore = new PersonalityStore();