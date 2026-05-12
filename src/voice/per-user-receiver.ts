import { EndBehaviorType } from '@discordjs/voice';
import { Transform, TransformCallback } from 'stream';
import { asrClient } from './asr-client';
import { sessionManager } from './session-manager';
import type { SessionContext, ActiveStream } from './types';

/**
 * Decodes raw Opus packets (48kHz stereo) and resamples to 16kHz mono s16le
 * in a single Transform stream, bypassing prism.FFmpeg entirely.
 *
 * Why not prism.FFmpeg:
 *   prism.FFmpeg._final() calls _cleanup() which SIGKILLs the FFmpeg process
 *   the moment the writable side ends. FFmpeg never flushes its output buffer,
 *   so ffmpegChunks is always 0.
 *
 * Resampling: 48kHz stereo → 16kHz mono = keep every 3rd stereo frame,
 * averaging L+R channels. Simple integer decimation (ratio 3:1).
 */
class OpusTo16kMonoStream extends Transform {
  private readonly encoder: any;
  // Carry-over buffer for incomplete stereo frames from previous chunk
  private remainder = Buffer.alloc(0);

  constructor() {
    super({ writableObjectMode: true, readableObjectMode: false });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { OpusEncoder } = require('@discordjs/opus');
    // 48kHz, 2 channels
    this.encoder = new OpusEncoder(48000, 2);
  }

  _transform(opusPacket: Buffer, _encoding: string, callback: TransformCallback): void {
    let pcm48stereo: Buffer;
    try {
      pcm48stereo = this.encoder.decode(opusPacket);
    } catch {
      // Corrupted packet — skip
      return callback();
    }

    // Prepend any leftover bytes from the previous chunk
    const buf = this.remainder.length > 0
      ? Buffer.concat([this.remainder, pcm48stereo])
      : pcm48stereo;

    // Each stereo frame = 4 bytes (2 bytes L + 2 bytes R)
    const STEREO_FRAME = 4;
    // Downsample ratio: 48000 / 16000 = 3
    const RATIO = 3;

    const totalFrames = Math.floor(buf.length / STEREO_FRAME);
    const outputFrames = Math.floor(totalFrames / RATIO);
    const out = Buffer.allocUnsafe(outputFrames * 2); // 2 bytes per mono s16le sample

    for (let i = 0; i < outputFrames; i++) {
      const srcFrame = i * RATIO;
      const srcByte = srcFrame * STEREO_FRAME;
      const l = buf.readInt16LE(srcByte);
      const r = buf.readInt16LE(srcByte + 2);
      // Average L+R for mono, clamp to int16 range
      const mono = Math.max(-32768, Math.min(32767, Math.round((l + r) / 2)));
      out.writeInt16LE(mono, i * 2);
    }

    // Save any leftover bytes that didn't fit into a complete RATIO-group
    const consumedFrames = outputFrames * RATIO;
    const consumedBytes = consumedFrames * STEREO_FRAME;
    this.remainder = buf.slice(consumedBytes);

    if (out.length > 0) {
      this.push(out);
    }
    callback();
  }

  _flush(callback: TransformCallback): void {
    this.remainder = Buffer.alloc(0);
    callback();
  }
}

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
    const map = this.active.get(ctx.id);
    if (!map) return;
    if (map.has(userId)) return; // already subscribed for this user

    const streamId = this.nextStreamId++;

    // Subscribe to the user's Opus stream; end after 800ms of silence
    const opusStream = ctx.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 800,
      },
    });

    // Decode Opus (48kHz stereo) and resample to 16kHz mono s16le in one step.
    // Bypasses prism.FFmpeg which SIGKILLs the process on stream end before
    // flushing output (prism.FFmpeg._final → _cleanup → process.kill('SIGKILL')).
    const converter = new OpusTo16kMonoStream();

    // Notify ASR client that this stream is opening
    asrClient.openStream(ctx, streamId, userId);

    // Pipe audio through the chain
    opusStream.pipe(converter);

    let pcmChunks = 0;
    converter.on('data', (chunk: Buffer) => {
      pcmChunks++;
      if (pcmChunks <= 3) {
        console.log(`[receiver] [stream ${streamId}] PCM chunk ${pcmChunks}: ${chunk.length}B`);
      }
      sessionManager.noteActivity(ctx.guildId);
      asrClient.sendPcm(ctx, streamId, chunk);
    });

    converter.on('end', () => {
      console.log(`[receiver] [stream ${streamId}] converter ended — pcmChunks=${pcmChunks}`);
    });

    converter.on('error', (err: Error) => {
      console.error(`[receiver] converter error for stream ${streamId}:`, err.message);
      cleanup();
    });

    const cleanup = () => {
      asrClient.closeStream(ctx, streamId);
      try { opusStream.destroy(); } catch { /* ignore */ }
      try { converter.destroy(); } catch { /* ignore */ }
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
