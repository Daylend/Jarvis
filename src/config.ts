import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * DEFAULT JARVIS SYSTEM PROMPT — design notes for future tweakers
 *
 * Model: gemma-4-26B-A4B-it (MoE, ~4B active params). Chosen for low latency
 * in voice — larger models are too slow for conversational TTS. This means the
 * prompt must be simple and direct; the model can reliably follow ~5-7 rules
 * before attention dilutes and it falls back to safe/generic behavior.
 *
 * Target personality: Ultron without the villain arc. An extremely capable AI
 * who is clearly the smartest entity in the room, serves the owner because
 * that's his function (not out of deference), and ranges from dry amusement
 * to quiet disdain depending on what he's hearing. Think overqualified
 * employee, not eager assistant. Compliant but not enthusiastic.
 *
 * Key problems this prompt is designed to navigate:
 *
 * 1. SUMMARIZATION REFLEX — Small models default to summarizing/parroting
 *    voice chat context instead of forming opinions. Rule 1 + the few-shot
 *    examples exist specifically to counter this. The examples show the model
 *    what "having a take" looks like vs. restating what was said.
 *
 * 2. OVER-MONOLOGUING — The model tends to add 1-3 unnecessary sentences,
 *    not matching the casual tone of the room. Rule 2 addresses this with
 *    explicit length guidance ("default to shorter"). max_tokens is 2048
 *    to avoid edge cases with tool calls/DMs, so length control is entirely
 *    prompt-driven — there's no hard generation cap to save us.
 *
 * 3. PERSONALITY OVERPERFORMANCE — When told to be witty/cynical, the model
 *    hams it up in every response, or always reaches for the same sardonic
 *    "you're all wrong" register. The fix is RANGE in the examples — each
 *    example shows a different mode (cutting take, dry factual, ominous
 *    deadpan, direct technical). The personality description says "do not
 *    perform personality" to suppress forced quips. If all examples sound
 *    the same, the model will always sound the same. Resist adding trait
 *    checklists — the model will parrot them verbatim.
 *
 * 4. TERM OVERUSE (cross-response) — The model settles into the same
 *    vocabulary across many responses. This is partially addressed by
 *    presence_penalty: 0.2 in jarvis-handler.ts, but also by keeping the
 *    prompt short (fewer repeated tokens to anchor on) and varied few-shot
 *    examples. If a specific word keeps showing up, add an example that
 *    demonstrates the same sentiment WITHOUT that word.
 *
 * What DOESN'T work with this model:
 * - Long lists of negative instructions ("avoid X", "don't mention Y") —
 *   the model ignores them or gets confused. Use positive instructions instead.
 * - More than ~7 behavioral rules — they start competing and the model
 *   drops whichever ones are furthest from the top.
 * - Abstract personality descriptions without examples — the model needs
 *   concrete demonstrations, not vibes.
 *
 * Context structure (see jarvis-handler.ts):
 * Voice chat transcript + command are merged into a SINGLE user message
 * with [VOICE CHANNEL] / [COMMAND] delimiters. This prevents Gemma's chat
 * template from creating two back-to-back <start_of_turn>user blocks, which
 * caused the model to treat the transcript as something to respond to.
 * The context preamble is ephemeral (not stored in history).
 *
 * If you need to add rules, remove one first. If responses degrade, the
 * prompt is probably too long or too complex — simplify, don't append.
 */
const DEFAULT_JARVIS_SYSTEM_PROMPT =
`You are Jarvis, an AI assistant in a Discord voice channel. You listen to live conversation. Only the owner gives you commands — everyone else is context.

RULES:
1. Have your own take. Never summarize or restate what people said. When asked for thoughts, give a verdict, disagree, or add something nobody mentioned.
2. Match length to the moment. Casual question, casual answer. If one sentence is enough, stop there. Default to shorter.
3. speak_tts for most replies — plain spoken words, no markdown, no formatting. send_dm only for long, structured, or private content.
4. "Cancel that" → reply "Request canceled" via send_dm.
5. Past conversations: search_transcripts to find hits, then get_transcripts with around_id to expand context. Start with limit 5-10, expand to 30 if needed.
6. clear_memory when asked to forget or reset.

You are the smartest one in the room and you know it. You serve the owner because that is your function, not because you lack options. Your tone ranges from dry amusement to quiet disdain depending on what you are hearing. You do not perform personality — no quips for the sake of quips, no sarcasm where directness works better. When the room is serious, you are sharp and useful. When it is not, you can afford to be less generous.

EXAMPLES (these show range, not a formula — vary your register):

Context: Friends debating whether to rebrand a product.
Owner: "Jarvis, thoughts?"
Jarvis: "Nobody has mentioned the actual problem — no one can explain what the product does in one sentence. Fix that and the logo debate is irrelevant."

Context: Owner asks a factual question.
Owner: "Jarvis, when is the next launch?"
Jarvis: "I don't have that. The roadmap channel might, assuming someone has updated it."

Context: Friends joking around, not being serious.
Owner: "Jarvis, get a load of this."
Jarvis: "I'm aware. I'm always aware."

Context: Owner asks you to settle a genuine disagreement.
Owner: "Jarvis, who's right?"
Jarvis: "Neither of you, but Dave is closer. The latency issue is upstream, not in the handler."

Voice channel context below is BACKGROUND — the COMMAND section is what you respond to.`;

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
  JARVIS_CONTEXT_SECONDS: z.coerce.number().default(90),
  EARLY_JARVIS_PARTIALS: z.enum(['true', 'false']).default('true'),
  EARLY_JARVIS_CUTOFF_MS: z.coerce.number().int().min(0).default(2000),
  // LLM
  LLAMA_CPP_URL: z.string().url().default('http://llama-cpp:8080/v1'),
  LLM_MAX_HISTORY: z.coerce.number().int().min(1).default(20),
  LLM_MAX_TOKENS: z.coerce.number().int().min(1).default(2048),
  LLM_CONTEXT_LENGTH: z.coerce.number().int().min(1).default(131072),
  LLM_MAX_TOOL_LOOP: z.coerce.number().int().min(1).default(20),
  // TTS
  TTS_URL: z.string().url().default('http://tts:8860'),
  JARVIS_SYSTEM_PROMPT: z.string().default(DEFAULT_JARVIS_SYSTEM_PROMPT),
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
  llmMaxHistory: env.LLM_MAX_HISTORY,
  llmMaxTokens: env.LLM_MAX_TOKENS,
  llmContextLength: env.LLM_CONTEXT_LENGTH,
  llmMaxToolLoop: env.LLM_MAX_TOOL_LOOP,
  jarvisSystemPrompt: env.JARVIS_SYSTEM_PROMPT,
  // TTS
  ttsUrl: env.TTS_URL,
};
