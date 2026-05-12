import type { Client } from 'discord.js';
import { normalizer } from './normalizer';
import { registerOwnerWatch } from './owner-watch';

export { sessionManager } from './session-manager';
export { normalizer } from './normalizer';
export { transcriptStore } from './transcript-store';
export { actionRouter } from './action-router';
export { registerOwnerWatch } from './owner-watch';

/**
 * Bootstrap the voice subsystem.
 * Call once after the Discord client is ready.
 */
export async function bootstrapVoice(client: Client): Promise<void> {
  // Load term aliases from DB (seeds from JSON if empty)
  await normalizer.load();

  // Register the VoiceStateUpdate handler for owner auto-join
  registerOwnerWatch(client);

  console.log('[voice] Voice subsystem ready.');
}
