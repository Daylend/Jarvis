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
  type: 'ready' | 'partial' | 'final' | 'reopen' | 'error' | 'pong';
  streamId?: number;
  /** Stable per-utterance id from the ASR engine. Present on every `partial` and `final`. */
  lineId?: number | string;
  text?: string;
  startMs?: number;
  endMs?: number;
  confidence?: number | null;
  message?: string;
  engine?: string;
  model?: string;
  vulkan?: boolean;
  /** True when Smart Turn closed the segment early and the bot should hold the
   *  final for a grace window in case a `reopen` arrives (speech resumed). */
  provisional?: boolean;
}
