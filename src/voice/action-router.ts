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
}

export const actionRouter = new ActionRouter();
