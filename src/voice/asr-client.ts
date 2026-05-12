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
}

const MAX_BUFFERED = 1_000_000; // 1 MB
const PING_INTERVAL_MS = 15_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

class AsrClient {
  private sessions = new Map<string, SessionState>();

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
    this.sendJson(state, { type: 'open', streamId, userId });
  }

  closeStream(ctx: SessionContext, streamId: number): void {
    const state = this.sessions.get(ctx.id);
    if (!state) return;
    state.openStreams.delete(streamId);
    this.sendJson(state, { type: 'close', streamId });
  }

  // ─── Audio data ───────────────────────────────────────────────────────────

  /** streamId -> number of PCM chunks sent (for diagnostic throttling) */
  private sendPcmCount = new Map<number, number>();

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
    const n = (this.sendPcmCount.get(streamId) ?? 0) + 1;
    this.sendPcmCount.set(streamId, n);
    if (n <= 5) {
      console.log(`[asr-client] sendPcm stream=${streamId} chunk=${n} bytes=${pcm.length} wsState=${state.ws.readyState}`);
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
        engineHint: 'whisper-turbo',
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
        const raw = data.toString();
        const msg: AsrMessage = JSON.parse(raw);
        // DIAGNOSTIC: log every message received from the ASR sidecar
        if (msg.type !== 'pong') {
          console.log(`[asr-client] ← received type="${msg.type}" streamId=${(msg as any).streamId ?? 'n/a'} text=${JSON.stringify((msg as any).text ?? '')}`);
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

      case 'partial':
        actionRouter.onPartial(state.ctx, msg);
        break;

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

    const userId = state.streamUsers.get(msg.streamId);
    if (!userId) {
      console.warn(`[asr-client] Final for unknown streamId ${msg.streamId}`);
      return;
    }

    const textNormalized = normalizer.apply(msg.text);

    const replacements = msg.text !== textNormalized
      ? ` (${(msg.text.split(' ').length - textNormalized.split(' ').length)} replacements)`
      : '';
    // Primary transcript log — "User: hello world"
    console.log(`[transcript] User ${userId}: ${textNormalized}${replacements}`);
    console.log(`[asr] [${userId}] raw="${msg.text}"${replacements}`);

    await transcriptStore.save({
      sessionId: state.ctx.id,
      guildId: state.ctx.guildId,
      channelId: state.ctx.channelId,
      userId,
      startMs: msg.startMs ?? 0,
      endMs: msg.endMs ?? 0,
      textRaw: msg.text,
      textNormalized,
      confidence: msg.confidence ?? null,
    });

    await actionRouter.onFinal(state.ctx, {
      ...msg,
      textNormalized,
      userId,
    });
  }
}

export const asrClient = new AsrClient();
