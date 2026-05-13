import { Events } from 'discord.js';
import type { Client, VoiceBasedChannel } from 'discord.js';
import { config } from '../config';
import { sessionManager } from './session-manager';

const noop = () => {};

export function registerOwnerWatch(client: Client): void {
  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    // ── 1) Per-user stream cleanup — applies to every user, not just the owner ──
    // When any user leaves the voice channel that hosts our active session,
    // close their long-lived ASR stream so the sidecar releases the Transcriber.
    if (oldChannelId && oldChannelId !== newChannelId) {
      const ctx = sessionManager.get(oldState.guild.id);
      if (ctx && ctx.channelId === oldChannelId) {
        const { perUserReceiver } = await import('./per-user-receiver');
        perUserReceiver.closeUser(ctx, oldState.id);
      }
    }

    // ── 2) Owner auto-join / auto-leave ──
    if (newState.id !== config.ownerId) return;
    if (!config.autoJoinOwner) return;

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
