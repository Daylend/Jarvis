import type { Client } from 'discord.js';
import type { SessionContext } from './types';
import { config } from '../config';
import { skillStore } from './skill-store';
import { phraseTriggerRegistry } from './phrase-trigger-registry';

export async function onSessionStart(client: Client, ctx: SessionContext): Promise<void> {
  await phraseTriggerRegistry.loadFromDb();

  try {
    const skills = await skillStore.list(config.ownerId);
    const toStart = skills.filter((s: any) => s.autoStart && !s.active);

    if (toStart.length === 0) return;

    const { createTriggerFirer } = await import('./jarvis-handler');
    const firer = createTriggerFirer(client);

    for (const skill of toStart) {
      console.log(`[skill-runtime] Auto-starting skill "${skill.name}" for guild ${ctx.guildId}`);
      await skillStore.setActive(skill.id, true);

      void firer({
        trigger: {
          id: 0,
          ownerId: config.ownerId,
          guildId: ctx.guildId,
          channelId: ctx.channelId,
          label: null,
          instruction: skill.playbook,
          phrases: [],
          type: 'time',
        },
        occasion: 'skill-autostart',
        ctx,
      }).catch((err) => console.error(`[skill-runtime] Auto-start firer error for "${skill.name}":`, (err as Error).message));
    }
  } catch (err) {
    console.error('[skill-runtime] onSessionStart error:', (err as Error).message);
  }
}