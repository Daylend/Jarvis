import { createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } from '@discordjs/voice';
import type { VoiceConnection } from '@discordjs/voice';
import axios from 'axios';
import { Readable } from 'stream';
import { config } from '../config';

class TtsClient {
  private activePlayers = new Map<string, {
    player: ReturnType<typeof createAudioPlayer>;
    busy: boolean;
  }>();
  private queues = new Map<string, Array<() => Promise<void>>>();

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

          let entry = this.activePlayers.get(guildId);
          if (!entry) {
            const player = createAudioPlayer();
            player.on('error', (err) => {
              console.error(`[tts-client] AudioPlayer error in guild ${guildId}:`, err.message);
            });
            connection.subscribe(player);
            entry = { player, busy: false };
            this.activePlayers.set(guildId, entry);
          }

          await this._play(entry!, resource, guildId);

          const elapsed = Math.round(performance.now() - t0);
          console.log(`[tts-client] Finished speaking in ${elapsed}ms (guild ${guildId})`);
          resolve();
        } catch (err) {
          reject(err);
        }

        this._dequeue(guildId);
      };

      this._enqueue(guildId, task);
    });
  }

  private _enqueue(guildId: string, task: () => Promise<void>): void {
    let queue = this.queues.get(guildId);
    if (!queue) {
      queue = [];
      this.queues.set(guildId, queue);
    }
    queue.push(task);

    const entry = this.activePlayers.get(guildId);
    if (!entry?.busy && queue.length === 1) {
      task();
    }
  }

  private _dequeue(guildId: string): void {
    const queue = this.queues.get(guildId);
    if (!queue) return;
    queue.shift();
    if (queue.length > 0) {
      queue[0]();
    }
  }

  private _play(
    entry: NonNullable<ReturnType<typeof this.activePlayers.get>>,
    resource: ReturnType<typeof createAudioResource>,
    guildId: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      entry.busy = true;

      const onIdle = () => {
        entry.player.removeListener('error', onError);
        entry.busy = false;
        resolve();
      };

      const onError = (err: Error) => {
        entry.player.removeListener(AudioPlayerStatus.Idle, onIdle);
        entry.busy = false;
        reject(err);
      };

      entry.player.once(AudioPlayerStatus.Idle, onIdle);
      entry.player.once('error', onError);

      entry.player.play(resource as any);
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
    const entry = this.activePlayers.get(guildId);
    if (entry) {
      entry.player.stop(true);
      this.activePlayers.delete(guildId);
    }
    this.queues.delete(guildId);
  }
}

export const ttsClient = new TtsClient();
