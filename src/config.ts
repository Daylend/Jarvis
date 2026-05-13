import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  DISCORD_TOKEN: z.string(),
  CLIENT_ID: z.string(),
  OWNER_USER_ID: z.string(),
  DATABASE_URL: z.string(),
  OPENWEBUI_API_URL: z.string().url(),
  OPENWEBUI_API_KEY: z.string(),
  // Voice / transcription
  TRANSCRIBE_WS_URL: z.string().url().default('ws://localhost:8765/ws/transcribe'),
  TRANSCRIBE_HTTP_URL: z.string().url().default('http://localhost:8765'),
  AUTO_JOIN_OWNER: z.enum(['true', 'false']).default('true'),
  VOICE_IDLE_TIMEOUT_SEC: z.coerce.number().default(900),
  TRIGGER_PHRASE: z.string().default('jarvis'),
  JARVIS_CONTEXT_SECONDS: z.coerce.number().default(180),
  EARLY_JARVIS_PARTIALS: z.enum(['true', 'false']).default('false'),
});

const env = envSchema.parse(process.env);

export const config = {
  discordToken: env.DISCORD_TOKEN,
  clientId: env.CLIENT_ID,
  ownerId: env.OWNER_USER_ID,
  openWebUiUrl: env.OPENWEBUI_API_URL,
  openWebUiKey: env.OPENWEBUI_API_KEY,
  // Voice / transcription
  transcribeWsUrl: env.TRANSCRIBE_WS_URL,
  transcribeHttpUrl: env.TRANSCRIBE_HTTP_URL,
  autoJoinOwner: env.AUTO_JOIN_OWNER === 'true',
  voiceIdleTimeoutSec: env.VOICE_IDLE_TIMEOUT_SEC,
  triggerPhrase: env.TRIGGER_PHRASE,
  jarvisContextSeconds: env.JARVIS_CONTEXT_SECONDS,
  earlyJarvisPartials: env.EARLY_JARVIS_PARTIALS === 'true',
};
