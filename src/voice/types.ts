import type { VoiceConnection } from '@discordjs/voice';

export interface SessionContext {
  id: string;                        // VoiceSession.id (cuid)
  guildId: string;
  channelId: string;
  startedAt: Date;
  startedBy: string;                 // userId that triggered the session
  connection: VoiceConnection;
}

export interface ActiveStream {
  streamId: number;                  // unique within session
  userId: string;
  startedAt: number;                 // performance.now() at open time
  cleanup: () => void;
}

export interface AsrSegment {
  sessionId: string;
  guildId: string;
  channelId: string;
  userId: string;
  startMs: number;
  endMs: number;
  textRaw: string;
  textNormalized: string;
  confidence?: number | null;
}

/** Shape of any message received from the ASR sidecar. The discriminator is `type`. */
export interface AsrMessage {
  type: 'ready' | 'partial' | 'final' | 'error' | 'pong';
  streamId?: number;
  /** Stable per-utterance id from Moonshine. Present on every `partial` and `final`. */
  lineId?: number | string;
  text?: string;
  startMs?: number;
  endMs?: number;
  confidence?: number | null;
  message?: string;
  engine?: string;
  model?: string;
  vulkan?: boolean;
}
