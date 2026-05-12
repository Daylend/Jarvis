import { Events } from 'discord.js';
import type { Client, VoiceBasedChannel } from 'discord.js';
import { config } from '../config';
import { sessionManager } from './session-manager';

const noop = () => {};

export function registerOwnerWatch(client: Client): void {
  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    // Only react to the owner's voice state changes
    if (newState.id !== config.ownerId) return;
    if (!config.autoJoinOwner) return;

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    // No change in channel
    if (oldChannelId === newChannelId) return;

    if (newChannelId) {
      // Owner joined or moved to a new channel
      const channel = newState.channel as VoiceBasedChannel | null;
      if (!channel) return;

      console.log(`[owner-watch] Owner joined channel ${channel.name} (${newChannelId}) in guild ${newState.guild.id}`);

      try {
        await sessionManager.start({
          guild: newState.guild,
          voiceChannel: channel,
          startedBy: config.ownerId,
        });
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('already in progress')) {
          // Duplicate VoiceStateUpdate fired — safe to ignore
          console.debug('[owner-watch] Ignoring duplicate start request (already in progress)');
        } else {
          console.error('[owner-watch] Failed to start session:', err);
        }
      }
    } else {
      // Owner left voice entirely
      console.log(`[owner-watch] Owner left voice in guild ${oldState.guild.id}`);
      await sessionManager.stop(oldState.guild.id, 'owner-left').catch(noop);
    }
  });
}
