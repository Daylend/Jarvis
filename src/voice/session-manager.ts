import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';
import type { Guild, VoiceBasedChannel } from 'discord.js';
import { prisma } from '../db';
import { config } from '../config';
import type { SessionContext } from './types';

interface StartOpts {
  guild: Guild;
  voiceChannel: VoiceBasedChannel;
  startedBy: string;
}

class SessionManager {
  private byGuild = new Map<string, SessionContext>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Guilds where a start() is currently in-flight — prevents concurrent starts */
  private starting = new Set<string>();

  async start(opts: StartOpts): Promise<SessionContext> {
    const { guild, voiceChannel, startedBy } = opts;

    // Guard against concurrent start() calls for the same guild
    if (this.starting.has(guild.id)) {
      throw new Error(`Session start already in progress for guild ${guild.id}`);
    }
    this.starting.add(guild.id);

    try {
      return await this._start(opts);
    } finally {
      this.starting.delete(guild.id);
    }
  }

  private async _start(opts: StartOpts): Promise<SessionContext> {
    const { guild, voiceChannel, startedBy } = opts;

    // Tear down any existing session in this guild first
    if (this.byGuild.has(guild.id)) {
      await this.stop(guild.id, 'replaced');
    }

    // Create DB record
    const record = await (prisma as any).voiceSession.create({
      data: {
        guildId: guild.id,
        channelId: voiceChannel.id,
        startedBy,
      },
    });

    // Join the voice channel
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true, // bot doesn't speak yet
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      connection.destroy();
      await (prisma as any).voiceSession.update({
        where: { id: record.id },
        data: { endedAt: new Date() },
      });
      throw new Error(`Failed to join voice channel: ${(err as Error).message}`);
    }

    const ctx: SessionContext = {
      id: record.id,
      guildId: guild.id,
      channelId: voiceChannel.id,
      startedAt: record.startedAt,
      startedBy,
      connection,
    };

    this.byGuild.set(guild.id, ctx);
    console.log(`[session] Started session ${ctx.id} in guild ${guild.id} channel ${voiceChannel.id}`);

    // Handle unexpected disconnects — attempt to reconnect, then give up.
    // Per @discordjs/voice docs: on Disconnected, call rejoin() to trigger
    // a reconnect attempt, then wait up to 15s for Connecting or Signalling.
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        connection.rejoin();
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 15_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 15_000),
        ]);
      } catch {
        // Reconnect failed — only stop if this session is still the active one
        if (this.byGuild.get(guild.id) === ctx) {
          console.warn(`[session] Connection lost for session ${ctx.id}, stopping.`);
          await this.stop(guild.id, 'disconnected').catch(() => {});
        }
      }
    });

    // Late-require to avoid circular dependency at module load time
    const { asrClient } = await import('./asr-client');
    const { perUserReceiver } = await import('./per-user-receiver');

    asrClient.openForSession(ctx);
    perUserReceiver.attach(ctx);

    this.resetIdleTimer(guild.id);

    return ctx;
  }

  async stop(guildId: string, reason: string): Promise<void> {
    const ctx = this.byGuild.get(guildId);
    if (!ctx) return;

    console.log(`[session] Stopping session ${ctx.id} (reason: ${reason})`);

    // Clear idle timer
    this.clearIdleTimer(guildId);

    // Late-require to avoid circular dependency
    const { asrClient } = await import('./asr-client');
    const { perUserReceiver } = await import('./per-user-receiver');

    perUserReceiver.detach(ctx);
    asrClient.closeForSession(ctx);

    try { ctx.connection.destroy(); } catch { /* ignore */ }

    await (prisma as any).voiceSession.update({
      where: { id: ctx.id },
      data: { endedAt: new Date() },
    }).catch((err: Error) => console.error('[session] Failed to stamp endedAt:', err));

    this.byGuild.delete(guildId);
    console.log(`[session] Session ${ctx.id} ended.`);
  }

  get(guildId: string): SessionContext | undefined {
    return this.byGuild.get(guildId);
  }

  /** Reset the idle timer for a guild. Called on each PCM packet received. */
  noteActivity(guildId: string): void {
    this.resetIdleTimer(guildId);
  }

  async shutdownAll(): Promise<void> {
    const guildIds = [...this.byGuild.keys()];
    await Promise.all(guildIds.map((id) => this.stop(id, 'shutdown')));
  }

  private resetIdleTimer(guildId: string): void {
    this.clearIdleTimer(guildId);
    const timer = setTimeout(async () => {
      console.log(`[session] Idle timeout reached for guild ${guildId}, stopping session.`);
      await this.stop(guildId, 'idle').catch(() => {});
    }, config.voiceIdleTimeoutSec * 1000);
    this.idleTimers.set(guildId, timer);
  }

  private clearIdleTimer(guildId: string): void {
    const t = this.idleTimers.get(guildId);
    if (t) { clearTimeout(t); this.idleTimers.delete(guildId); }
  }
}

export const sessionManager = new SessionManager();
