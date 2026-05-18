import type { Client, VoiceBasedChannel } from 'discord.js';
import { config } from '../config';
import { transcriptStore } from './transcript-store';
import type { SessionContext, AsrMessage } from './types';

/** Milliseconds offset from session start, formatted as mm:ss */
function formatStamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export interface JarvisPayload {
  command: string;
  contextBlock: string;
  memberList: string;
  ctx: SessionContext;
  ownerText: string;
  ownerStartMs: number;
}

export type CommandHandler = (payload: JarvisPayload) => Promise<void>;

class ActionRouter {
  private client: Client | null = null;

  setClient(client: Client): void {
    this.client = client;
  }

  /**
   * Pluggable handler — replace this to wire in llamacpp + TTS.
   * Default: log the payload to console.
   */
  private handler: CommandHandler = async (p) => {
    console.log(`[jarvis] command: "${p.command}"`);
    console.log(`[jarvis] context window (${config.jarvisContextSeconds}s):\n${p.contextBlock || '(empty)'}`);
  };

  setHandler(h: CommandHandler): void {
    this.handler = h;
  }

  /** Called for every partial segment — reserved for future low-latency wake-word detection. */
  onPartial(_ctx: SessionContext, _msg: AsrMessage): void {
    // TODO: low-latency wake-word pre-detection
  }

  /**
   * Called for every finalized segment.
   * If the segment is from the owner and contains the trigger phrase,
   * assembles the Jarvis payload and dispatches to the handler.
   */
  async onFinal(
    ctx: SessionContext,
    msg: AsrMessage & { textNormalized: string; userId: string },
  ): Promise<void> {
    if (msg.userId !== config.ownerId) return;

    // If we already dispatched this utterance from an early partial or timer,
    // the final is just a correction — log it and skip.
    if (msg.streamId !== undefined && msg.lineId !== undefined) {
      const key = `${msg.streamId}:${msg.lineId}`;
      // Cancel any still-running early-dispatch timer.
      this.cancelEarlyTimer(key);
      if (this.dispatchedKeys.has(key)) {
        const finalText = msg.textNormalized ?? '';
        const dispatchedText = this.dispatchedTexts.get(key) ?? '';
        if (finalText !== dispatchedText) {
          console.log(`[jarvis] final correction lineId=${msg.lineId}: "${finalText}" (dispatched as "${dispatchedText}")`);
        } else {
          console.log(`[jarvis] final for already-dispatched utterance lineId=${msg.lineId} — skipping`);
        }
        this.dispatchedKeys.delete(key);
        this.dispatchedTexts.delete(key);
        return;
      }
    }

    const trigger = config.triggerPhrase.toLowerCase();
    const normalized = msg.textNormalized.toLowerCase();
    const idx = normalized.indexOf(trigger);
    if (idx < 0) return;

    // Extract command text: try after the trigger word first, fall back to
    // text before the trigger (end-of-sentence addressing like "What do you think Jarvis?")
    const after = msg.textNormalized
      .slice(idx + trigger.length)
      .replace(/^[\s,.;:!?-]+/, '')
      .trim();

    const before = msg.textNormalized
      .slice(0, idx)
      .replace(/[\s,.;:!?-]+$/, '')
      .trim();

    const command = after || before;

    if (!command) {
      console.log(`[jarvis] Trigger detected but no command text found. Ignoring.`);
      return;
    }

    console.log(`[jarvis] dispatching from final streamId=${msg.streamId} lineId=${msg.lineId} command="${command}"`);
    await this.dispatchJarvis(ctx, msg, command);
  }

  /** Shared dispatch: fetches context window and invokes the handler. */
  private async dispatchJarvis(
    ctx: SessionContext,
    msg: AsrMessage & { textNormalized: string; userId: string },
    command: string,
  ): Promise<void> {
    const windowMs = config.jarvisContextSeconds * 1000;
    const rows = await transcriptStore.contextWindow(ctx.guildId, ctx.channelId, windowMs);

    const nameMap = new Map<string, string>();
    if (this.client) {
      const guild = this.client.guilds.cache.get(ctx.guildId);
      if (guild) {
        const uniqueUserIds = [...new Set(rows.map((r: any) => r.userId as string))];
        for (const uid of uniqueUserIds) {
          const member = guild.members.cache.get(uid);
          if (member) {
            const display = member.displayName;
            nameMap.set(uid, uid === config.ownerId ? `${display} (Owner)` : display);
          }
        }
      }
    }

    const contextBlock = rows
      .map((r: any) => {
        const name = nameMap.get(r.userId) ?? `<@${r.userId}>`;
        return `[${formatStamp(r.startMs)}] ${name}: ${r.textNormalized}`;
      })
      .join('\n');

    let memberList = '';
    if (this.client) {
      try {
        const guild = this.client.guilds.cache.get(ctx.guildId);
        const channel = guild?.channels.cache.get(ctx.channelId);
        if (channel && 'members' in channel) {
          const voiceChannel = channel as VoiceBasedChannel;
          const names = voiceChannel.members
            .filter((m) => !m.user.bot)
            .map((m) => m.id === config.ownerId ? `${m.displayName} (Owner)` : m.displayName);
          if (names.length > 0) {
            memberList = `Users currently in voice channel: ${names.join(', ')}`;
          }
        }
      } catch (err) {
        console.warn('[jarvis] Failed to build member list:', err);
      }
    }

    const payload: JarvisPayload = {
      command,
      contextBlock,
      memberList,
      ctx,
      ownerText: msg.textNormalized,
      ownerStartMs: msg.startMs ?? 0,
    };

    try {
      await this.handler(payload);
    } catch (err) {
      console.error('[jarvis] Handler error:', err);
    }
  }

  private static readonly PARTIAL_TRACKING_MAX = 1024;

  /** Maps "streamId:lineId" to a running early-dispatch timer and the latest
   *  command tail text. On first partial with trigger+tail, a real setTimeout
   *  is started; subsequent partials update the tail; the timer fires with
   *  whatever tail is current when the cutoff is reached. */
  private partialFirstSeen = new Map<string, {
    firstSeenAt: number;
    latestTail: string;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** FIFO key order for bounded eviction of partialFirstSeen. */
  private partialKeyOrder: string[] = [];
  /** Keys we've already dispatched from a partial — prevents double-fires. */
  private dispatchedKeys = new Set<string>();
  /** Dispatched command text for correction logging when the final arrives. */
  private dispatchedTexts = new Map<string, string>();

  /**
   * Called for every partial from the owner. On the first partial containing
   * the trigger phrase + ≥2 command words, starts a real setTimeout for
   * config.earlyJarvisCutoffMs. Subsequent partials update the latest tail
   * text. When the timer fires (or the final arrives first), dispatches the
   * Jarvis handler with the best text available at that moment.
   */
  noteEarlyJarvis(
    ctx: SessionContext,
    msg: AsrMessage & { textNormalized: string; userId: string },
  ): void {
    if (!config.earlyJarvisPartials) return;
    if (msg.userId !== config.ownerId) return;
    if (msg.streamId === undefined || msg.lineId === undefined) return;

    const key = `${msg.streamId}:${msg.lineId}`;
    if (this.dispatchedKeys.has(key)) return;

    const trigger = config.triggerPhrase.toLowerCase();
    const idx = msg.textNormalized.toLowerCase().indexOf(trigger);
    if (idx < 0) return;

    let tail = msg.textNormalized
      .slice(idx + trigger.length)
      .replace(/^[\s,.;:!?-]+/, '')
      .trim();
    let tailWords = tail.split(/\s+/).filter(Boolean);
    if (tailWords.length < 2) {
      // Fall back to text before the trigger (end-of-sentence addressing)
      tail = msg.textNormalized
        .slice(0, idx)
        .replace(/[\s,.;:!?-]+$/, '')
        .trim();
      tailWords = tail.split(/\s+/).filter(Boolean);
    }
    if (tailWords.length < 2) return;

    // --- Time-based cutoff with a real timer ---------------------------
    const existing = this.partialFirstSeen.get(key);

    if (existing) {
      // Already tracking this key — update the latest tail text.
      existing.latestTail = tail;
      console.log(`[jarvis] early candidate (update) streamId=${msg.streamId} lineId=${msg.lineId} tail="${tail}" cutoffIn=${Math.round((config.earlyJarvisCutoffMs - (Date.now() - existing.firstSeenAt)) / 100) / 10}s`);
      return;
    }

    // First time seeing this key — record it, start a real timer, and
    // maintain FIFO eviction bounds.
    this.partialKeyOrder.push(key);
    while (this.partialKeyOrder.length > ActionRouter.PARTIAL_TRACKING_MAX) {
      const oldest = this.partialKeyOrder.shift()!;
      const entry = this.partialFirstSeen.get(oldest);
      if (entry) {
        clearTimeout(entry.timer);
        this.partialFirstSeen.delete(oldest);
      }
      this.dispatchedKeys.delete(oldest);
      this.dispatchedTexts.delete(oldest);
    }

    const entry = {
      firstSeenAt: Date.now(),
      latestTail: tail,
      timer: null as any as ReturnType<typeof setTimeout>,
    };

    // Start a real setTimeout — fires even if no further partials arrive
    // (e.g. Moonshine hangs after the user stops speaking).
    entry.timer = setTimeout(() => {
      // Guard: already dispatched from a final? Cleaned up?
      const cur = this.partialFirstSeen.get(key);
      if (!cur) return;

      const dispatchTail = cur.latestTail;
      this.dispatchedKeys.add(key);
      this.dispatchedTexts.set(key, dispatchTail);
      this.partialFirstSeen.delete(key);

      console.log(`[jarvis] dispatching from timer streamId=${msg.streamId} lineId=${msg.lineId} tail="${dispatchTail}" cutoffMs=${config.earlyJarvisCutoffMs}`);

      this.dispatchJarvis(ctx, msg, dispatchTail).catch((err) =>
        console.error('[jarvis] Timer dispatch error:', err),
      );
    }, config.earlyJarvisCutoffMs);

    this.partialFirstSeen.set(key, entry);

    console.log(`[jarvis] early candidate (first) streamId=${msg.streamId} lineId=${msg.lineId} tail="${tail}" timerStarted=${config.earlyJarvisCutoffMs}ms`);
  }

  /**
   * Cancel any pending early-dispatch timer for a key. Called from onFinal()
   * when the final arrives before the timer fires.
   */
  private cancelEarlyTimer(key: string): void {
    const entry = this.partialFirstSeen.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      this.partialFirstSeen.delete(key);
    }
  }
}

export const actionRouter = new ActionRouter();
