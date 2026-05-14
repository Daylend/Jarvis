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

    // If we already dispatched this utterance from a stable partial, the
    // final is just a correction — log it and skip.
    if (msg.streamId !== undefined && msg.lineId !== undefined) {
      const key = `${msg.streamId}:${msg.lineId}`;
      if (this.dispatchedKeys.has(key)) {
        const finalText = msg.textNormalized ?? '';
        const dispatchedText = this.dispatchedTexts.get(key) ?? '';
        if (finalText !== dispatchedText) {
          console.log(`[jarvis] final correction lineId=${msg.lineId}: "${finalText}" (dispatched as "${dispatchedText}")`);
        } else {
          console.log(`[jarvis] final for already-dispatched utterance lineId=${msg.lineId} — skipping`);
        }
        this.partialTextByKey.delete(key);
        this.dispatchedKeys.delete(key);
        this.dispatchedTexts.delete(key);
        return;
      }
    }

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

    console.log(`[jarvis] dispatching from final streamId=${msg.streamId} lineId=${msg.lineId}`);
    await this.dispatchJarvis(ctx, msg, after);
  }

  /** Shared dispatch: fetches context window and invokes the handler. */
  private async dispatchJarvis(
    ctx: SessionContext,
    msg: AsrMessage & { textNormalized: string; userId: string },
    command: string,
  ): Promise<void> {
    const windowMs = config.jarvisContextSeconds * 1000;
    const rows = await transcriptStore.contextWindow(ctx.guildId, ctx.channelId, windowMs);

    const contextBlock = rows
      .map((r) => `[${formatStamp(r.startMs)}] <@${r.userId}>: ${r.textNormalized}`)
      .join('\n');

    const payload: JarvisPayload = {
      command,
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

  private static readonly PARTIAL_TRACKING_MAX = 1024;

  /** Maps "streamId:lineId" to partial command text and the number of
   *  consecutive partials where that text has remained stable. */
  private partialTextByKey = new Map<string, { text: string; stableCount: number }>();
  /** FIFO key order for bounded eviction of partialTextByKey. */
  private partialKeyOrder: string[] = [];
  /** Keys we've already dispatched from a partial — prevents double-fires. */
  private dispatchedKeys = new Set<string>();
  /** Dispatched command text for correction logging when the final arrives. */
  private dispatchedTexts = new Map<string, string>();

  /**
   * Called for every partial from the owner. If the trigger phrase is present
   * and the command tail (words after trigger) stabilises across
   * config.earlyJarvisStableCount consecutive partials, fire the Jarvis
   * handler immediately instead of waiting for the final.
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

    const tail = msg.textNormalized
      .slice(idx + trigger.length)
      .replace(/^[\s,.;:!?-]+/, '')
      .trim();
    const tailWords = tail.split(/\s+/).filter(Boolean);
    if (tailWords.length < 2) return;

    // --- Stabilisation: only fire when the command text hasn't changed
    //     for earlyJarvisStableCount consecutive partials ---------------
    const prev = this.partialTextByKey.get(key);
    if (prev && prev.text === tail) {
      prev.stableCount++;
    } else {
      // Text changed or first time we see this key
      if (!prev) {
        this.partialKeyOrder.push(key);
        while (this.partialKeyOrder.length > ActionRouter.PARTIAL_TRACKING_MAX) {
          const oldest = this.partialKeyOrder.shift()!;
          this.partialTextByKey.delete(oldest);
          this.dispatchedKeys.delete(oldest);
          this.dispatchedTexts.delete(oldest);
        }
      }
      this.partialTextByKey.set(key, { text: tail, stableCount: 1 });
    }

    const stableCount = this.partialTextByKey.get(key)!.stableCount;
    if (stableCount < config.earlyJarvisStableCount) {
      console.log(`[jarvis] early candidate streamId=${msg.streamId} lineId=${msg.lineId} tail="${tail}" stable=${stableCount}/${config.earlyJarvisStableCount}`);
      return;
    }

    // Stable — dispatch now
    this.dispatchedKeys.add(key);
    this.dispatchedTexts.set(key, tail);
    console.log(`[jarvis] dispatching from partial streamId=${msg.streamId} lineId=${msg.lineId} tail="${tail}"`);

    // Fire-and-forget: don't block the partial pipeline on handler I/O
    this.dispatchJarvis(ctx, msg, tail).catch((err) =>
      console.error('[jarvis] Partial dispatch error:', err),
    );
  }
}

export const actionRouter = new ActionRouter();
