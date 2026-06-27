import type { Client } from 'discord.js';
import { normalizer } from './normalizer';
import { actionRouter } from './action-router';
import { createJarvisHandler, handleDmJarvis, createTriggerFirer } from './jarvis-handler';
import { registerOwnerWatch, startupAutoJoin } from './owner-watch';
import { scheduler } from './scheduler';
import { phraseTriggerRegistry } from './phrase-trigger-registry';

export { sessionManager } from './session-manager';
export { normalizer } from './normalizer';
export { transcriptStore } from './transcript-store';
export { actionRouter } from './action-router';
export { registerOwnerWatch } from './owner-watch';
export { startupAutoJoin } from './owner-watch';
export { ttsClient } from './tts-client';
export { handleDmJarvis } from './jarvis-handler';
export { handleMentionJarvis } from './jarvis-handler';
export { clearAllHistory } from './jarvis-handler';
export { scheduler } from './scheduler';
export { phraseTriggerRegistry } from './phrase-trigger-registry';

export async function bootstrapVoice(client: Client): Promise<void> {
  await normalizer.load();

  actionRouter.setClient(client);

  actionRouter.setHandler(createJarvisHandler(client));

  const firer = createTriggerFirer(client);
  actionRouter.setTriggerFirer(firer);
  scheduler.setFireHandler((trigger) => firer({ trigger, occasion: 'time' }));

  await phraseTriggerRegistry.loadFromDb();
  await scheduler.init();

  registerOwnerWatch(client);
  await startupAutoJoin(client);

  console.log('[voice] Voice subsystem ready.');
}