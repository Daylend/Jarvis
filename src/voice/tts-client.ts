import { createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } from '@discordjs/voice';
import type { VoiceConnection } from '@discordjs/voice';
import axios from 'axios';
import { Readable } from 'stream';
import fs from 'fs';
import { config } from '../config';

/**
 * Continuous silent WAV stream. Emits a 44-byte WAV header (stereo 48kHz
 * 16-bit PCM, data length 0xFFFFFFFF) followed by silent PCM frames forever.
 * Fed via StreamType.Arbitrary so @discordjs/voice's FFmpeg decodes it into
 * Opus silence. Keeping the AudioPlayer in Playing state with this resource
 * holds Discord's green "speaking" indicator without producing audible sound.
 * Destroyed (or stopped via player.stop()) to release the hold.
 */
class SilentWavStream extends Readable {
  private headerSent = false;
  private stopped = false;
  private static readonly SILENT_FRAME = Buffer.alloc(4096); // zeros = silence

  _read(): void {
    if (this.stopped) return;
    if (!this.headerSent) {
      this.headerSent = true;
      this.push(this.buildHeader());
      return;
    }
    // Keep pushing silence; never push null (never end).
    if (!this.push(SilentWavStream.SILENT_FRAME)) {
      // backpressure — will resume on next _read
    }
  }

  _destroy(): void {
    this.stopped = true;
  }

  private buildHeader(): Buffer {
    const buf = Buffer.alloc(44);
    let o = 0;
    buf.write('RIFF', o); o += 4;
    buf.writeUInt32LE(0xffffffff, o); o += 4; // file size - 8 (unknown/large)
    buf.write('WAVE', o); o += 4;
    buf.write('fmt ', o); o += 4;
    buf.writeUInt32LE(16, o); o += 4; // PCM fmt chunk size
    buf.writeUInt16LE(1, o); o += 2;  // PCM
    buf.writeUInt16LE(2, o); o += 2;  // 2 channels (stereo)
    buf.writeUInt32LE(48000, o); o += 4; // sample rate
    buf.writeUInt32LE(192000, o); o += 4; // byte rate (48000*2*2)
    buf.writeUInt16LE(4, o); o += 2;  // block align (2*2)
    buf.writeUInt16LE(16, o); o += 2; // bits per sample
    buf.write('data', o); o += 4;
    buf.writeUInt32LE(0xffffffff, o); o += 4; // data size (unknown/large)
    return buf;
  }
}

interface GuildPlayer {
  player: ReturnType<typeof createAudioPlayer>;
  busy: boolean;
  queue: Array<() => Promise<void>>;
  // Ack session state
  ackHolding: boolean;
  ackReleased: boolean;
  ackRefCount: number;
  fillerActive: boolean;
  fillerStream: SilentWavStream | null;
}

class TtsClient {
  private guilds = new Map<string, GuildPlayer>();

  private ensurePlayer(connection: VoiceConnection, guildId: string): GuildPlayer {
    let entry = this.guilds.get(guildId);
    if (entry) return entry;
    const player = createAudioPlayer();
    player.on('error', (err) => {
      console.error(`[tts-client] AudioPlayer error in guild ${guildId}:`, err.message);
    });
    connection.subscribe(player);
    entry = {
      player,
      busy: false,
      queue: [],
      ackHolding: false,
      ackReleased: false,
      ackRefCount: 0,
      fillerActive: false,
      fillerStream: null,
    };
    this.guilds.set(guildId, entry);
    return entry;
  }

  /** Drive the next real task, or filler silence, or leave idle. */
  private runNext(connection: VoiceConnection, entry: GuildPlayer, guildId: string): void {
    if (entry.busy) return;

    if (entry.queue.length > 0) {
      const task = entry.queue.shift()!;
      entry.busy = true;
      task()
        .catch((err) => console.error(`[tts-client] task error in guild ${guildId}:`, err))
        .finally(() => {
          entry.busy = false;
          this.runNext(connection, entry, guildId);
        });
      return;
    }

    // No real tasks queued.
    if (entry.ackHolding && !entry.ackReleased) {
      this.startFiller(connection, entry, guildId);
      return;
    }

    // Idle — indicator off.
  }

  private startFiller(connection: VoiceConnection, entry: GuildPlayer, guildId: string): void {
    if (entry.fillerActive) return;
    entry.fillerActive = true;
    entry.busy = true;
    const stream = new SilentWavStream();
    entry.fillerStream = stream;
    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });

    const onIdle = () => {
      entry.player.removeListener('error', onError);
      entry.fillerActive = false;
      entry.fillerStream = null;
      entry.busy = false;
      this.runNext(connection, entry, guildId);
    };
    const onError = (err: Error) => {
      entry.player.removeListener(AudioPlayerStatus.Idle, onIdle);
      entry.fillerActive = false;
      entry.fillerStream = null;
      entry.busy = false;
      console.error(`[tts-client] filler error in guild ${guildId}:`, err.message);
      this.runNext(connection, entry, guildId);
    };

    entry.player.once(AudioPlayerStatus.Idle, onIdle);
    entry.player.once('error', onError);
    entry.player.play(resource as any);
  }

  /** Interrupt filler so a queued real task can run immediately. */
  private preemptFiller(entry: GuildPlayer): void {
    if (entry.fillerActive) {
      entry.player.stop(true);
    }
  }

  private enqueue(connection: VoiceConnection, guildId: string, task: () => Promise<void>): void {
    const entry = this.ensurePlayer(connection, guildId);
    entry.queue.push(task);
    // If filler is holding the player, interrupt it so the real task runs now.
    if (entry.fillerActive) {
      this.preemptFiller(entry);
      return;
    }
    this.runNext(connection, entry, guildId);
  }

  /** Play a resource on the guild player; resolves when playback finishes. */
  private playOnce(entry: GuildPlayer, resource: ReturnType<typeof createAudioResource>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onIdle = () => {
        entry.player.removeListener('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        entry.player.removeListener(AudioPlayerStatus.Idle, onIdle);
        reject(err);
      };
      entry.player.once(AudioPlayerStatus.Idle, onIdle);
      entry.player.once('error', onError);
      entry.player.play(resource as any);
    });
  }

  /**
   * Synthesize text to speech and play it in the given voice connection.
   * Returns a promise that resolves when playback finishes.
   */
  async speak(connection: VoiceConnection, text: string, guildId: string): Promise<void> {
    console.log(`[tts-client] Speaking in guild ${guildId}: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);
    const t0 = performance.now();

    return new Promise<void>((resolve, reject) => {
      const task = async () => {
        try {
          const wavBuffer = await this.synthesize(text);
          const resource = createAudioResource(Readable.from(wavBuffer), {
            inputType: StreamType.Arbitrary,
          });
          const entry = this.ensurePlayer(connection, guildId);
          await this.playOnce(entry, resource);
          const elapsed = Math.round(performance.now() - t0);
          console.log(`[tts-client] Finished speaking in ${elapsed}ms (guild ${guildId})`);
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      this.enqueue(connection, guildId, task);
    });
  }

  /**
   * Begin an acknowledgement session: play the ack sound once, then hold the
   * speaking indicator green (via silent filler) until endAck drains the
   * reference count. Overlapping beginAck calls maintain the hold without
   * replaying the sound.
   */
  beginAck(connection: VoiceConnection, ackFilePath: string, guildId: string): void {
    const entry = this.ensurePlayer(connection, guildId);
    entry.ackRefCount += 1;

    if (entry.ackRefCount > 1) {
      // Session already active — just maintain the hold, no sound replay.
      return;
    }

    // New session: arm hold and play the ack sound as a real task.
    entry.ackHolding = true;
    entry.ackReleased = false;
    console.log(`[tts-client] beginAck (sound=${ackFilePath}) in guild ${guildId}`);

    const task = async () => {
      if (!fs.existsSync(ackFilePath)) {
        console.warn(`[tts-client] ack sound missing: ${ackFilePath}`);
        return;
      }
      const resource = createAudioResource(ackFilePath);
      await this.playOnce(entry, resource);
    };
    this.enqueue(connection, guildId, task);
  }

  /** Release one ack reference; when the count hits zero, stop holding. */
  endAck(guildId: string): void {
    const entry = this.guilds.get(guildId);
    if (!entry) return;
    if (entry.ackRefCount <= 0) return;
    entry.ackRefCount -= 1;
    if (entry.ackRefCount === 0) {
      entry.ackHolding = false;
      entry.ackReleased = true;
      // If filler is currently holding, stop it so the indicator turns off.
      if (entry.fillerActive) {
        entry.player.stop(true);
      }
      console.log(`[tts-client] endAck (released) in guild ${guildId}`);
    }
  }

  /** Play a sound file once (one-shot, no hold). Used by /jarvis ack test. */
  async playSoundFile(connection: VoiceConnection, filePath: string, guildId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const task = async () => {
        if (!fs.existsSync(filePath)) {
          reject(new Error(`Sound file not found: ${filePath}`));
          return;
        }
        const resource = createAudioResource(filePath);
        await this.playOnce(this.ensurePlayer(connection, guildId), resource);
        resolve();
      };
      this.enqueue(connection, guildId, task);
    });
  }

  private async synthesize(text: string): Promise<Buffer> {
    const response = await axios.post(
      `${config.ttsUrl}/tts`,
      { text },
      {
        responseType: 'arraybuffer',
        headers: { 'Content-Type': 'application/json' },
        timeout: 60_000,
      },
    );
    const inferenceMs = response.headers['x-inference-ms'];
    console.log(`[tts-client] TTS synth done in ${inferenceMs ?? '?'}ms, bytes=${response.data.length}`);
    return Buffer.from(response.data);
  }

  async checkHealth(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await axios.get(`${config.ttsUrl}/healthz`, { timeout: 2000 });
      const data = res.data as any;
      const detail = `engine: ${data.engine ?? '?'}, model: ${data.model ?? '?'}, device: ${data.device ?? '?'}`;
      return { ok: data.status === 'ok', detail };
    } catch (err) {
      const msg = (err as Error).message;
      return { ok: false, detail: `unreachable: ${msg}` };
    }
  }

  /** Dispose of a player when the guild session ends */
  removeGuild(guildId: string): void {
    const entry = this.guilds.get(guildId);
    if (entry) {
      entry.ackHolding = false;
      entry.ackReleased = true;
      entry.ackRefCount = 0;
      if (entry.fillerStream) {
        entry.fillerStream.destroy();
        entry.fillerStream = null;
      }
      entry.player.stop(true);
      this.guilds.delete(guildId);
    }
  }
}

export const ttsClient = new TtsClient();
