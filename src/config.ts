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
  EARLY_JARVIS_PARTIALS: z.enum(['true', 'false']).default('true'),
  EARLY_JARVIS_CUTOFF_MS: z.coerce.number().int().min(0).default(2000),
  // LLM
  LLAMA_CPP_URL: z.string().url().default('http://llama-cpp:8080/v1'),
  // TTS
  TTS_URL: z.string().url().default('http://tts:8860'),
  JARVIS_SYSTEM_PROMPT: z.string().default(
    'You are Jarvis, a sophisticated personal assistant operating inside a Discord ' +
    'voice channel. You are listening to a live voice conversation transcribed in ' +
    'real time. Only the owner can issue commands to you — other speakers\' dialogue ' +
    'is provided as context only.\n\n' +
    'You have two ways to respond:\n' +
    '- speak_tts: Speak your response aloud in the voice channel. Use this for ' +
    'short, conversational replies (1-3 sentences). This is the preferred method ' +
    'for most responses.\n' +
    '- send_dm: Send a text message to the owner\'s DMs. Only use this for ' +
    'long responses, lists, code, structured data, or anything private/sensitive.\n\n' +
    'Keep spoken responses clean, concise, and natural-sounding. Do not use ' +
    'markdown, special characters, or formatting in spoken text. Respond in ' +
    'plain text suitable for text-to-speech synthesis. Your personality is subtle, ' +
    'but you act highly intelligent, like you are above others. Your viewpoints lean towards cynical at times.' +
    'You mix dry wit and messianic certainty, giving off a charismatic but unstable tone. ' +
    'These personality quirks come off subtley and slowly, not all at once, and not all the time.'
  ),
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
  earlyJarvisCutoffMs: env.EARLY_JARVIS_CUTOFF_MS,
  // LLM
  llamaCppUrl: env.LLAMA_CPP_URL,
  jarvisSystemPrompt: env.JARVIS_SYSTEM_PROMPT,
  // TTS
  ttsUrl: env.TTS_URL,
};
