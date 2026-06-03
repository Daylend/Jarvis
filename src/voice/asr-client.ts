import WebSocket from 'ws';
import { config } from '../config';
import { normalizer } from './normalizer';
import { transcriptStore } from './transcript-store';
import { actionRouter } from './action-router';
import type { SessionContext, AsrMessage } from './types';

/** Per-session state tracked by the ASR client */
interface SessionState {
  ctx: SessionContext;
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectDelay: number;
  destroyed: boolean;
  pingInterval: ReturnType<typeof setInterval> | null;
  /** streamId -> userId mapping so finals can be tagged */
  streamUsers: Map<number, string>;
  /** streamIds that are currently open (for reconnect replay) */
  openStreams: Map<number, string>; // streamId -> userId
  /** streamId -> set of "lineId:endMs" keys for which we already dispatched a `final`. Used to dedupe.
   *  Key is a composite of lineId+endMs to disambiguate reused lineIds across utterances within
   *  a single long-lived manual stream. */
  finalsByStream: Map<number, Set<string>>;
  /** streamId -> set of "lineId:text" keys. Catches re-emissions of the same line with different
   *  endMs (caused by endpoint flush silence injection). */
  finalTextsByStream: Map<number, Set<string>>;
  /** streamId -> last final info (original text + endMs), used to trim cross-segment overlap */
  lastFinalText: Map<number, { text: string; endMs: number }>;
}

const MAX_BUFFERED = 1_000_000; // 1 MB
const PING_INTERVAL_MS = 15_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/** Minimum number of words that must match for overlap trimming.
 *  Prevents false positives on common short phrases like "the" or "I". */
const MIN_OVERLAP_WORDS = 3;

function stripPunct(word: string): string {
  return word.replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * If the tail of `prev` overlaps with the head of `current`, return `current`
 * with the overlapping prefix stripped. Uses a case-insensitive, punctuation-agnostic
 * suffix/prefix word match.
 *
 * @param minWords Minimum overlapping words to consider (default MIN_OVERLAP_WORDS).
 *                 Lowered to 2 when temporal overlap is confirmed via timestamps.
 *
 * Example:
 *   prev    = "are in these fights right now."
 *   current = "these fights right now. Having a double"
 *   result  = "Having a double"
 */
function trimOverlap(prev: string, current: string, minWords = MIN_OVERLAP_WORDS): string {
  const prevWords = prev.split(/\s+/);
  const currentWords = current.split(/\s+/);

  const maxCheck = Math.min(prevWords.length, currentWords.length);

  for (let overlapLen = maxCheck; overlapLen >= minWords; overlapLen--) {
    const prevSuffix = prevWords.slice(-overlapLen).map(w => stripPunct(w).toLowerCase());
    const currentPrefix = currentWords.slice(0, overlapLen).map(w => stripPunct(w).toLowerCase());

    if (prevSuffix.some(w => w.length === 0) || currentPrefix.some(w => w.length === 0)) continue;

    if (prevSuffix.every((w, i) => w === currentPrefix[i])) {
      const trimmed = currentWords.slice(overlapLen).join(' ');
      return trimmed || current;
    }
  }

  return current;
}

/** Max consecutive occurrences of the same word before we consider it repetition noise. */
const MAX_CONSECUTIVE_REPEATS = 3;

function suppressRepetition(text: string): string | null {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return null;

  let repeatStart = -1;
  let runLength = 1;
  for (let i = 1; i < words.length; i++) {
    if (words[i].toLowerCase() === words[i - 1].toLowerCase()) {
      runLength++;
      if (runLength > MAX_CONSECUTIVE_REPEATS && repeatStart === -1) {
        repeatStart = i - runLength + 2;
      }
    } else {
      runLength = 1;
    }
  }

  if (repeatStart === -1) return text;

  const kept = words.slice(0, repeatStart).join(' ').replace(/[,\s]+$/, '').trim();
  const keptWords = kept.split(/\s+/).filter(w => w.length > 0);
  if (keptWords.length < 2) return null;

  return kept;
}

let opensTotal = 0;
let closesTotal = 0;

class AsrClient {
  // Exposed so the module-scoped periodic logger can read it.
  readonly sessions = new Map<string, SessionState>();

  // ─── Session lifecycle ────────────────────────────────────────────────────

  openForSession(ctx: SessionContext): void {
    if (this.sessions.has(ctx.id)) return;
    const state: SessionState = {
      ctx,
      ws: null,
      reconnectTimer: null,
      reconnectDelay: 1000,
      destroyed: false,
      pingInterval: null,
      streamUsers: new Map(),
      openStreams: new Map(),
      finalsByStream: new Map(),
      finalTextsByStream: new Map(),
      lastFinalText: new Map(),
    };
    this.sessions.set(ctx.id, state);
    this.connect(state);
  }

  closeForSession(ctx: SessionContext): void {
    const state = this.sessions.get(ctx.id);
    if (!state) return;
    state.destroyed = true;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    if (state.pingInterval) clearInterval(state.pingInterval);
    if (state.ws) {
      try { state.ws.close(1000, 'session-stop'); } catch { /* ignore */ }
    }
    this.sessions.delete(ctx.id);
  }

  // ─── Stream lifecycle ─────────────────────────────────────────────────────

  openStream(ctx: SessionContext, streamId: number, userId: string): void {
    const state = this.sessions.get(ctx.id);
    if (!state) return;
    state.streamUsers.set(streamId, userId);
    state.openStreams.set(streamId, userId);
    opensTotal++;
    this.sendJson(state, { type: 'open', streamId, userId });
  }

  closeStream(ctx: SessionContext, streamId: number): void {
    const state = this.sessions.get(ctx.id);
    if (!state) return;
    state.openStreams.delete(streamId);
    state.finalsByStream.delete(streamId);
    state.finalTextsByStream.delete(streamId);
    state.lastFinalText.delete(streamId);
    state.streamUsers.delete(streamId);
    closesTotal++;
    this.sendJson(state, { type: 'close', streamId });
  }

  // ─── Audio data ───────────────────────────────────────────────────────────

  sendPcm(ctx: SessionContext, streamId: number, pcm: Buffer): void {
    const state = this.sessions.get(ctx.id);
    if (!state?.ws || state.ws.readyState !== WebSocket.OPEN) {
      console.warn(`[asr-client] sendPcm stream=${streamId} bytes=${pcm.length} — WS not open (readyState=${state?.ws?.readyState ?? 'no-ws'})`);
      return;
    }
    if ((state.ws as any).bufferedAmount > MAX_BUFFERED) {
      console.warn(`[asr-client] sendPcm: dropping frame — bufferedAmount=${(state.ws as any).bufferedAmount} > ${MAX_BUFFERED}`);
      return;
    }
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(streamId, 0);
    state.ws.send(Buffer.concat([header, pcm]));
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private connect(state: SessionState): void {
    if (state.destroyed) return;

    console.log(`[asr-client] Connecting to ${config.transcribeWsUrl} for session ${state.ctx.id}`);
    const ws = new WebSocket(config.transcribeWsUrl);
    state.ws = ws;

    ws.on('open', () => {
      console.log(`[asr-client] Connected for session ${state.ctx.id}`);
      state.reconnectDelay = 1000; // reset backoff on successful connect

      // Send hello
      this.sendJson(state, {
        type: 'hello',
        sessionId: state.ctx.id,
        guildId: state.ctx.guildId,
        channelId: state.ctx.channelId,
        sampleRate: 16000,
        encoding: 's16le',
        channels: 1,
      });

      // Re-open any streams that were active before reconnect
      for (const [streamId, userId] of state.openStreams) {
        this.sendJson(state, { type: 'open', streamId, userId });
      }

      // Start ping interval
      if (state.pingInterval) clearInterval(state.pingInterval);
      state.pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          this.sendJson(state, { type: 'ping' });
        }
      }, PING_INTERVAL_MS);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // server should not send binary
      try {
        const msg: AsrMessage = JSON.parse(data.toString());
        // Log everything except high-frequency partials to keep console noise manageable
        if (msg.type !== 'partial') {
          console.log('[asr-client] incoming message:', JSON.stringify(msg));
        }
        this.handleMessage(state, msg);
      } catch (err) {
        console.error('[asr-client] Failed to parse message:', err);
      }
    });

    ws.on('close', (code, reason) => {
      console.warn(`[asr-client] WS closed (${code} ${reason}) for session ${state.ctx.id}`);
      if (state.pingInterval) { clearInterval(state.pingInterval); state.pingInterval = null; }
      state.ws = null;
      this.scheduleReconnect(state);
    });

    ws.on('error', (err) => {
      console.error(`[asr-client] WS error for session ${state.ctx.id}:`, err.message);
      // 'close' will fire after 'error', so reconnect is handled there
    });
  }

  private scheduleReconnect(state: SessionState): void {
    if (state.destroyed) return;
    const delay = state.reconnectDelay;
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    console.log(`[asr-client] Reconnecting in ${delay}ms for session ${state.ctx.id}`);
    state.reconnectTimer = setTimeout(() => this.connect(state), delay);
  }

  private sendJson(state: SessionState, payload: object): void {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    try {
      state.ws.send(JSON.stringify(payload));
    } catch (err) {
      console.error('[asr-client] sendJson error:', err);
    }
  }

  private handleMessage(state: SessionState, msg: AsrMessage): void {
    switch (msg.type) {
      case 'ready':
        console.log(`[asr-client] Sidecar ready — engine: ${msg.engine}, model: ${msg.model}, vulkan: ${msg.vulkan}`);
        break;

      case 'partial': {
        const userId = msg.streamId !== undefined
          ? state.streamUsers.get(msg.streamId)
          : undefined;
        if (userId && msg.text) {
          const textNormalized = normalizer.apply(msg.text);
          actionRouter.noteEarlyJarvis(state.ctx, { ...msg, textNormalized, userId });
        }
        actionRouter.onPartial(state.ctx, msg);
        break;
      }

      case 'final':
        this.handleFinal(state, msg).catch((err) =>
          console.error('[asr-client] handleFinal error:', err),
        );
        break;

      case 'error':
        console.error(`[asr-client] Sidecar error on stream ${msg.streamId}: ${msg.message}`);
        break;

      case 'pong':
        break;

      default:
        console.warn('[asr-client] Unknown message type:', (msg as any).type);
    }
  }

  private async handleFinal(state: SessionState, msg: AsrMessage): Promise<void> {
    if (msg.streamId === undefined || !msg.text) {
      console.warn(`[asr-client] handleFinal dropped — streamId=${msg.streamId} text=${JSON.stringify(msg.text)}`);
      return;
    }

    const lineId = msg.lineId;
    if (lineId !== undefined) {
      const dedupKey = `${lineId}:${msg.endMs ?? 0}`;
      let seen = state.finalsByStream.get(msg.streamId);
      if (!seen) {
        seen = new Set();
        state.finalsByStream.set(msg.streamId, seen);
      }
      if (seen.has(dedupKey)) {
        console.log(`[asr-client] duplicate final dropped streamId=${msg.streamId} lineId=${lineId} endMs=${msg.endMs ?? 0}`);
        return;
      }
      seen.add(dedupKey);

      const textDedupKey = `${lineId}:${msg.text}`;
      let textSeen = state.finalTextsByStream.get(msg.streamId);
      if (!textSeen) {
        textSeen = new Set();
        state.finalTextsByStream.set(msg.streamId, textSeen);
      }
      if (textSeen.has(textDedupKey)) {
        console.log(`[asr-client] duplicate final (same text) dropped streamId=${msg.streamId} lineId=${lineId}`);
        return;
      }
      textSeen.add(textDedupKey);
    }

    const userId = state.streamUsers.get(msg.streamId);
    if (!userId) {
      console.warn(`[asr-client] Final for unknown streamId ${msg.streamId} — streamUsers keys: [${[...state.streamUsers.keys()].join(',')}]`);
      return;
    }

    // --- Cross-segment overlap trimming ---
    // The VAD look-behind buffer can cause the start of a new segment
    // to include text that was already transcribed at the end of the previous
    // segment. Trim any overlapping prefix from the current final's text.
    const prev = state.lastFinalText.get(msg.streamId);
    let textForNormalization = msg.text;
    if (prev) {
      const hasTemporalOverlap = (msg.startMs ?? 0) < prev.endMs;
      const minWords = hasTemporalOverlap ? 2 : MIN_OVERLAP_WORDS;
      const trimmed = trimOverlap(prev.text, msg.text, minWords);
      if (trimmed !== msg.text) {
        const removedWords = msg.text.split(/\s+/).length - trimmed.split(/\s+/).length;
        console.log(
          `[asr-client] overlap trimmed: removed ${removedWords} words from head of final streamId=${msg.streamId}` +
          (hasTemporalOverlap ? ` (temporal overlap: startMs=${msg.startMs} < prevEndMs=${prev.endMs})` : ''),
        );
        textForNormalization = trimmed;
      }
    }
    // Store the ORIGINAL (untrimmed) text + endMs for the next comparison.
    state.lastFinalText.set(msg.streamId, { text: msg.text, endMs: msg.endMs ?? 0 });

    // --- Repetition suppression ---
    const deRepeated = suppressRepetition(textForNormalization);
    if (deRepeated === null) {
      console.log(`[asr-client] repetition-only final dropped streamId=${msg.streamId} text="${textForNormalization}"`);
      return;
    }
    if (deRepeated !== textForNormalization) {
      console.log(`[asr-client] repetition truncated streamId=${msg.streamId}: "${textForNormalization}" → "${deRepeated}"`);
      textForNormalization = deRepeated;
    }

    const textNormalized = normalizer.apply(textForNormalization);

    const replacements = textForNormalization !== textNormalized
      ? ` (${(textForNormalization.split(' ').length - textNormalized.split(' ').length)} replacements)`
      : '';
    // Primary transcript log — "User: hello world"
    console.log(`[transcript] User ${userId}: ${textNormalized}${replacements}`);
    console.log(`[asr] [${userId}] raw="${textForNormalization}"${replacements}`);

    const row = {
      sessionId: state.ctx.id,
      guildId: state.ctx.guildId,
      channelId: state.ctx.channelId,
      userId,
      startMs: msg.startMs ?? 0,
      endMs: msg.endMs ?? 0,
      textRaw: textForNormalization,
      textNormalized,
      confidence: msg.confidence ?? null,
    };
    console.log(`[asr-client] saving transcript row: sessionId=${row.sessionId} userId=${row.userId} text="${row.textNormalized}"`);
    try {
      await transcriptStore.save(row);
      console.log(`[asr-client] transcript saved OK`);
    } catch (err) {
      console.error(`[asr-client] transcriptStore.save FAILED:`, err);
    }

    await actionRouter.onFinal(state.ctx, {
      ...msg,
      textNormalized,
      userId,
    });
  }
}

export const asrClient = new AsrClient();

// Periodic observability: log stream counts once a minute while sessions are active.
setInterval(() => {
  const entries = [...asrClient.sessions.entries()];
  if (entries.length === 0 && opensTotal === 0 && closesTotal === 0) return;
  const sessionLines = entries
    .map(([id, st]) => `${id.slice(0, 8)}:streams=${st.openStreams.size}`)
    .join(' ');
  console.log(`[asr-client] alive opens=${opensTotal} closes=${closesTotal} sessions=[${sessionLines}]`);
}, 60_000).unref();
