import { EndBehaviorType, generateDependencyReport } from '@discordjs/voice';
import { PassThrough } from 'stream';
import * as prism from 'prism-media';
import { asrClient } from './asr-client';
import { sessionManager } from './session-manager';
import type { SessionContext, ActiveStream } from './types';

// Print dependency report once at module load so we can see which Opus/sodium libs are active
console.log('[receiver] Dependency report:\n' + generateDependencyReport());

class PerUserReceiver {
  /** sessionId -> (userId -> ActiveStream) */
  private active = new Map<string, Map<string, ActiveStream>>();
  private nextStreamId = 1;

  attach(ctx: SessionContext): void {
    if (this.active.has(ctx.id)) return;
    this.active.set(ctx.id, new Map());

    const receiver = ctx.connection.receiver;

    receiver.speaking.on('start', (userId: string) => {
      this.openStream(ctx, userId);
    });
  }

  detach(ctx: SessionContext): void {
    const map = this.active.get(ctx.id);
    if (!map) return;
    for (const [, stream] of map) {
      stream.cleanup();
    }
    this.active.delete(ctx.id);
  }

  private openStream(ctx: SessionContext, userId: string): void {
    console.log('[receiver] BUILD MARK pcm-debug-v1');
    const map = this.active.get(ctx.id);
    if (!map) return;
    if (map.has(userId)) return; // already subscribed for this user

    const streamId = this.nextStreamId++;

    // Subscribe to the user's Opus stream — use Manual end while debugging so the
    // stream doesn't close before we can confirm packets are arriving
    const opusStream = ctx.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.Manual,
      },
    });

    // Auto-close after 5s of silence (replaces AfterSilence while debugging)
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    const resetSilenceTimer = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        console.log(`[receiver] [stream ${streamId}] silence timeout — destroying opusStream`);
        opusStream.destroy();
      }, 1500);
    };

    // Decode Opus (48kHz stereo) to raw PCM s16le
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    // Resample 48kHz stereo → 16kHz mono s16le via FFmpeg
    const ffmpeg = new prism.FFmpeg({
      args: [
        '-loglevel', 'error',
        '-f', 's16le', '-ar', '48000', '-ac', '2',
        '-i', 'pipe:0',
        '-f', 's16le', '-ar', '16000', '-ac', '1',
        'pipe:1',
      ],
    });

    // Notify ASR client that this stream is opening
    asrClient.openStream(ctx, streamId, userId);

    // Tap the opus stream via a PassThrough so we can count packets without
    // splitting the pipe (adding a 'data' listener AND piping would split the stream)
    let opusPackets = 0;
    const opusTap = new PassThrough();
    opusTap.on('data', (packet: Buffer) => {
      opusPackets++;
      resetSilenceTimer();
      if (opusPackets <= 5) {
        console.log(`[receiver] [stream ${streamId}] raw opus packet ${opusPackets}: ${packet.length}B`);
      }
    });

    // Pipe audio through the chain: opusStream → tap → decoder → ffmpeg
    opusStream.pipe(opusTap).pipe(decoder).pipe(ffmpeg);

    ffmpeg.on('data', (chunk: Buffer) => {
      console.log(`[receiver] FFmpeg PCM ${chunk.length}B`);
      sessionManager.noteActivity(ctx.guildId);
      asrClient.sendPcm(ctx, streamId, chunk);
    });

    ffmpeg.on('error', (err: Error) => {
      console.error('[receiver] FFmpeg error', err);
      cleanup();
    });

    decoder.on('error', (err: Error) => {
      console.error('[receiver] Opus decoder error', err);
    });

    opusStream.on('end', () => {
      console.log('[receiver] opusStream ended');
    });

    opusStream.on('close', () => {
      console.log('[receiver] opusStream closed');
    });

    const cleanup = () => {
      asrClient.closeStream(ctx, streamId);
      try { opusStream.destroy(); } catch { /* ignore */ }
      try { decoder.destroy(); } catch { /* ignore */ }
      try { ffmpeg.destroy(); } catch { /* ignore */ }
      map.delete(userId);
    };

    opusStream.on('end', cleanup);
    opusStream.on('error', (err: Error) => {
      console.error(`[receiver] Opus stream error for user ${userId}:`, err.message);
      cleanup();
    });

    const activeStream: ActiveStream = {
      streamId,
      userId,
      startedAt: performance.now(),
      cleanup,
    };

    map.set(userId, activeStream);
    console.log(`[receiver] Opened stream ${streamId} for user ${userId} in session ${ctx.id}`);
  }
}

export const perUserReceiver = new PerUserReceiver();
