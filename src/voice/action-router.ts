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
  ctx: SessionContext;
  ownerText: string;
  ownerStartMs: number;
}

export type CommandHandler = (payload: JarvisPayload) => Promise<void>;

class ActionRouter {
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

    const trigger = config.triggerPhrase.toLowerCase();
    const normalized = msg.textNormalized.toLowerCase();
    const idx = normalized.indexOf(trigger);
    if (idx < 0) return;

    // Extract command text: everything after the trigger word
    const after = msg.textNormalized
      .slice(idx + trigger.length)
      .replace(/^[\s,.;:!?-]+/, '')
      .trim();

    if (!after) {
      console.log(`[jarvis] Trigger detected but no command text followed. Ignoring.`);
      return;
    }

    // Fetch context window: all users in the same channel, last N seconds
    const windowMs = config.jarvisContextSeconds * 1000;
    const rows = await transcriptStore.contextWindow(ctx.guildId, ctx.channelId, windowMs);

    const contextBlock = rows
      .map((r) => `[${formatStamp(r.startMs)}] <@${r.userId}>: ${r.textNormalized}`)
      .join('\n');

    const payload: JarvisPayload = {
      command: after,
      contextBlock,
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

  private static readonly EARLY_JARVIS_MAX = 1024;

  /** Map of "streamId:lineId" we have already considered for an early Jarvis fire.
   *  Bounded to EARLY_JARVIS_MAX entries via FIFO eviction to prevent unbounded growth
   *  across long-running sessions. */
  private earlyJarvisSeen: Set<string> = new Set();
  private earlyJarvisOrder: string[] = [];

  private rememberEarlyJarvis(key: string): void {
    if (this.earlyJarvisSeen.has(key)) return;
    this.earlyJarvisSeen.add(key);
    this.earlyJarvisOrder.push(key);
    while (this.earlyJarvisOrder.length > ActionRouter.EARLY_JARVIS_MAX) {
      const oldest = this.earlyJarvisOrder.shift()!;
      this.earlyJarvisSeen.delete(oldest);
    }
  }

  /**
   * Optional pre-detection: when EARLY_JARVIS_PARTIALS is enabled, look at
   * partials from the owner. If the trigger phrase is already present and a
   * command tail of >= 2 words has accumulated, log an "early candidate".
   * The actual handler dispatch still waits for the final to keep semantics
   * simple in v1 — this method is wiring only.
   */
  noteEarlyJarvis(
    _ctx: SessionContext,
    msg: AsrMessage & { textNormalized: string; userId: string },
  ): void {
    if (!config.earlyJarvisPartials) return;
    if (msg.userId !== config.ownerId) return;
    if (msg.streamId === undefined || msg.lineId === undefined) return;

    const key = `${msg.streamId}:${msg.lineId}`;
    if (this.earlyJarvisSeen.has(key)) return;

    const trigger = config.triggerPhrase.toLowerCase();
    const idx = msg.textNormalized.toLowerCase().indexOf(trigger);
    if (idx < 0) return;
    const tail = msg.textNormalized.slice(idx + trigger.length).trim();
    if (tail.split(/\s+/).filter(Boolean).length < 2) return;

    this.rememberEarlyJarvis(key);
    console.log(`[jarvis] early candidate streamId=${msg.streamId} lineId=${msg.lineId} tail="${tail}"`);
  }
}

export const actionRouter = new ActionRouter();
