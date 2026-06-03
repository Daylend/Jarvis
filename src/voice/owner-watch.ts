import { Events } from 'discord.js';
import type { Client, VoiceBasedChannel } from 'discord.js';
import { config } from '../config';
import { sessionManager } from './session-manager';

const noop = () => {};
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * On startup, scan all guilds the bot is in. If the owner is in a voice
 * channel (and autoJoinOwner is enabled), start a transcription session.
 */
export async function startupAutoJoin(client: Client): Promise<void> {
  if (!config.autoJoinOwner) return;

  for (const [, guild] of client.guilds.cache) {
    try {
      const member = await guild.members.fetch(config.ownerId).catch(() => null);
      if (!member) continue;

      const voiceChannel = member.voice.channel;
      if (!voiceChannel) continue;

      console.log(
        `[owner-watch] Startup: owner in ${voiceChannel.name} (${voiceChannel.id}) ` +
        `in guild ${guild.id}, auto-joining...`,
      );

      await sessionManager.start({
        guild,
        voiceChannel,
        startedBy: config.ownerId,
        client,
      });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('already in progress')) {
        // Another guild already started a session, or duplicate event — safe
        console.debug('[owner-watch] Startup auto-join: already in progress, skipping');
      } else {
        console.error(`[owner-watch] Startup auto-join failed for guild ${guild.id}:`, err);
      }
    }
  }
}

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

    // ── 2) Bot moved or disconnected → rejoin owner's current channel ──
    // This handles cases where a server admin moves the bot, or the bot is
    // disconnected from voice. We check the bot's own voice state and, if
    // the bot left the session's channel, try to rejoin wherever the owner is.
    if (newState.id === client.user?.id) {
      const ctx = sessionManager.get(newState.guild.id);
      if (!ctx) return; // No active session in this guild — nothing to recover

      // Bot was in our session channel but now is not (moved or disconnected)
      if (oldChannelId === ctx.channelId && newChannelId !== ctx.channelId) {
        if (!config.autoJoinOwner) {
          // Auto-join disabled — let the session die naturally
          console.log('[owner-watch] Bot left session channel but auto-join is disabled, doing nothing');
          return;
        }

        try {
          const ownerMember = await newState.guild.members.fetch(config.ownerId).catch(() => null);
          const ownerChannel = ownerMember?.voice.channel;

          if (ownerChannel) {
            console.log(
              `[owner-watch] Bot moved/disconnected from session channel, ` +
              `rejoining owner in ${ownerChannel.name} (${ownerChannel.id})`,
            );
            // sessionManager.start() first tears down the old session, then
            // creates a new one in the owner's channel.
            await sessionManager.start({
              guild: newState.guild,
              voiceChannel: ownerChannel,
              startedBy: config.ownerId,
              client,
            });
          } else {
            // Owner is not in voice — nothing to rejoin, stop the session
            console.log('[owner-watch] Bot moved/disconnected and owner not in voice, stopping session');
            await sessionManager.stop(newState.guild.id, 'bot-moved-owner-gone').catch(noop);
          }
        } catch (err) {
          const msg = (err as Error).message ?? '';
          if (msg.includes('already in progress')) {
            console.debug('[owner-watch] Rejoin already in progress, skipping');
          } else {
            console.error('[owner-watch] Failed to rejoin owner after bot move/disconnect:', err);
          }
        }
      }
      return;
    }

    // ── 3) Owner auto-join / auto-leave ──
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
        await delay(1000);
        await sessionManager.start({
          guild: newState.guild,
          voiceChannel: channel,
          startedBy: config.ownerId,
          client,
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
