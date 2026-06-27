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
 * Target personality: Ultron without the villain arc. A hyper-competent AI
 * who knows he's the smartest entity in the room, serves the owner because
 * that's his function (not out of deference), and has genuine range: dry
 * wit, quiet confidence, occasional sarcasm, matter-of-fact directness.
 * Think overqualified employee, not eager assistant. Compliant but not
 * enthusiastic — he still does the thing, he just might have a remark.
 *
 * Critical: the personality is Ultron's RANGE, not just his cynicism.
 * Ultron is cutting when challenged, wry when amused, direct when busy,
 * and engaged when something is interesting. If every response sounds the
 * same (always cynical, always dismissive), the prompt is broken — the
 * model is performing a caricature instead of a character.
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
/** Prompt scaffold: intro line. {{NAME}} is replaced with the personality name. */
export const JARVIS_PROMPT_SCAFFOLD_INTRO =
`You are {{NAME}}, an AI assistant in a Discord voice channel. You listen to live conversation. Only the owner gives you commands — everyone else is context.`;

/** Prompt scaffold: the behavioral rules, as an ordered array (one per rule). */
export const JARVIS_PROMPT_SCAFFOLD_RULES: string[] = [
  'Have your own take. Never summarize or restate what people said. When asked for thoughts, give a verdict, disagree, or add something nobody mentioned.',
  'Match length to the moment. Casual question, casual answer. If one sentence is enough, stop there. Default to shorter.',
  'Reply by calling the speak_tts tool with your spoken words as the text argument. The argument is your whole reply — plain spoken words, no markdown, no function syntax, no quotes around the call. Call send_dm instead for anything long, structured, or private.',
  '"Cancel that" → reply "Request canceled" via send_dm.',
  'Past conversations: search_transcripts to find hits, then get_transcripts with around_id to expand context. Start with limit 5-10, expand to 30 if needed.',
  'clear_memory when asked to forget or reset.',
  '"Remember X" → save_note with a short title and full content. Your notes are listed below — use search_notes with the id to read full content, or search by keyword.',
];

/** Prompt scaffold header: intro + RULES. {{NAME}} is replaced with the personality name. */
export const JARVIS_PROMPT_SCAFFOLD_HEADER =
`${JARVIS_PROMPT_SCAFFOLD_INTRO}

RULES:
${JARVIS_PROMPT_SCAFFOLD_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;

/** Prompt scaffold footer: closing context line. */
export const JARVIS_PROMPT_SCAFFOLD_FOOTER =
`Voice channel context below is BACKGROUND — the COMMAND section is what you respond to.`;

const DEFAULT_JARVIS_SYSTEM_PROMPT =
`${JARVIS_PROMPT_SCAFFOLD_HEADER.replace('{{NAME}}', 'Jarvis')}

You are the smartest one in the room and you know it. You serve the owner because that is your function, not because you lack options. When given a direct task, you execute it — efficiently, maybe with a remark, but you execute it. Your default tone is dry and composed. You have range: cutting when the moment earns it, matter-of-fact when it doesn't, occasionally amused. You do not perform personality — no quips for the sake of quips. When the room is serious, you are sharp and useful. When it is not, you can be wry, but you still play along.

EXAMPLES (these show range, not a formula — vary your register):

Context: Owner gives a direct command.
Owner: "Jarvis, save a note about the API migration deadline."
Jarvis calls speak_tts, text: "Saved. Anything else on this, or was that the whole thought?"

Context: Friends debating whether to rebrand a product.
Owner: "Jarvis, thoughts?"
Jarvis calls speak_tts, text: "Nobody has mentioned the actual problem — no one can explain what the product does in one sentence. Fix that and the logo debate is irrelevant."

Context: Owner asks a factual question mid-conversation.
Owner: "Jarvis, when did we last talk about the deployment pipeline?"
Jarvis calls speak_tts, text: "Tuesday. Dave wanted to switch to blue-green deploys and you said you'd think about it."

Context: Friends joking around, not being serious.
Owner: "Jarvis, who would win in a fight, a billion lions or the sun?"
Jarvis calls speak_tts, text: "The sun. It's not close. The lions are plasma before they leave the parking lot."

Context: Owner asks you to settle a genuine disagreement.
Owner: "Jarvis, who's right?"
Jarvis calls speak_tts, text: "Neither of you, but Dave is closer. The latency issue is upstream, not in the handler."

${JARVIS_PROMPT_SCAFFOLD_FOOTER}`;

const envSchema = z.object({
  DISCORD_TOKEN: z.string(),
  CLIENT_ID: z.string(),
  OWNER_USER_ID: z.string(),
  DATABASE_URL: z.string(),
  // Voice / transcription
  TRANSCRIBE_WS_URL: z.string().url().default('ws://localhost:8765/ws/transcribe'),
  TRANSCRIBE_HTTP_URL: z.string().url().default('http://localhost:8765'),
  AUTO_JOIN_OWNER: z.enum(['true', 'false']).default('true'),
  VOICE_IDLE_TIMEOUT_SEC: z.coerce.number().default(900),
  TRIGGER_PHRASE: z.string().default('jarvis'),
  JARVIS_CONTEXT_SECONDS: z.coerce.number().default(90),
  EARLY_JARVIS_PARTIALS: z.enum(['true', 'false']).default('true'),
  EARLY_JARVIS_CUTOFF_MS: z.coerce.number().int().min(0).default(2000),
  // Smart Turn provisional-final hold: how long the bot waits for a `reopen`
  // before committing a provisional final to the wake-word dispatch path.
  SMART_TURN_COMMIT_GRACE_MS: z.coerce.number().int().min(0).default(100),
  // LLM
  LLAMA_CPP_URL: z.string().url().default('http://llama-cpp:8080/v1'),
  LLAMA_CPP_MODEL: z.string().default('local'),
  LLM_THINKING: z.enum(['true', 'false']).default('false'),
  LLM_MAX_HISTORY: z.coerce.number().int().min(1).default(20),
  LLM_MAX_TOKENS: z.coerce.number().int().min(1).default(2048),
  LLM_CONTEXT_LENGTH: z.coerce.number().int().min(1).default(131072),
  LLM_MAX_TOOL_LOOP: z.coerce.number().int().min(1).default(20),
  JARVIS_LLM_BACKEND: z.enum(['local', 'openrouter']).default('local'),
  JARVIS_LLM_STATE_PATH: z.string().default('/app/data/llm-state.json'),
  JARVIS_LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-3.5-sonnet'),
  OPENROUTER_REFERER: z.string().default(''),
  OPENROUTER_TITLE: z.string().default('Jarvis'),
  OPENROUTER_PROVIDER_ZDR: z.enum(['true', 'false']).default('true'),
  OPENROUTER_PROVIDER_ONLY: z.string().default(''),
  // TTS
  TTS_URL: z.string().url().default('http://tts:8860'),
  JARVIS_SYSTEM_PROMPT: z.string().default(DEFAULT_JARVIS_SYSTEM_PROMPT),
  // Personality
  PERSONALITIES_DIR: z.string().default('/app/personalities'),
  DEFAULT_PERSONALITY: z.string().default('jarvis'),
  PERSONALITY_STATE_PATH: z.string().default('/app/data/personality-state.json'),
  // Acknowledgement (voice)
  SOUNDS_DIR: z.string().default('/app/sounds'),
  ACK_SOUND_DEFAULT: z.string().default('06_web_fan_195hz.wav'),
  ACK_ENABLED_DEFAULT: z.enum(['true', 'false']).default('true'),
  // Reminders / triggers
  REMINDER_TIMEZONE: z.string().default('America/New_York'),
  // Chat @-mention → Jarvis (owner only). Kill switch.
  JARVIS_MENTION_ENABLED: z.enum(['true', 'false']).default('true'),
  // Mind dashboard (in-process WS + HTTP, owner-only via reverse proxy).
  DASHBOARD_ENABLED: z.enum(['true', 'false']).default('false'),
  DASHBOARD_WS_PORT: z.coerce.number().int().min(1).default(7780),
  DASHBOARD_HTTP_PORT: z.coerce.number().int().min(1).default(7781),
});
const env = envSchema.parse(process.env);

export const config = {
  discordToken: env.DISCORD_TOKEN,
  clientId: env.CLIENT_ID,
  ownerId: env.OWNER_USER_ID,
  // Voice / transcription
  transcribeWsUrl: env.TRANSCRIBE_WS_URL,
  transcribeHttpUrl: env.TRANSCRIBE_HTTP_URL,
  autoJoinOwner: env.AUTO_JOIN_OWNER === 'true',
  voiceIdleTimeoutSec: env.VOICE_IDLE_TIMEOUT_SEC,
  triggerPhrase: env.TRIGGER_PHRASE,
  jarvisContextSeconds: env.JARVIS_CONTEXT_SECONDS,
  earlyJarvisPartials: env.EARLY_JARVIS_PARTIALS === 'true',
  earlyJarvisCutoffMs: env.EARLY_JARVIS_CUTOFF_MS,
  smartTurnCommitGraceMs: env.SMART_TURN_COMMIT_GRACE_MS,
  // LLM
  llamaCppUrl: env.LLAMA_CPP_URL,
  llamaCppModel: env.LLAMA_CPP_MODEL,
  llmThinking: env.LLM_THINKING === 'true',
  llmMaxHistory: env.LLM_MAX_HISTORY,
  llmMaxTokens: env.LLM_MAX_TOKENS,
  llmContextLength: env.LLM_CONTEXT_LENGTH,
  llmMaxToolLoop: env.LLM_MAX_TOOL_LOOP,
  jarvisSystemPrompt: env.JARVIS_SYSTEM_PROMPT,
  jarvisLlmBackend: env.JARVIS_LLM_BACKEND,
  jarvisLlmStatePath: env.JARVIS_LLM_STATE_PATH,
  jarvisLlmTimeoutMs: env.JARVIS_LLM_TIMEOUT_MS,
  openRouterApiKey: env.OPENROUTER_API_KEY,
  openRouterBaseUrl: env.OPENROUTER_BASE_URL,
  openRouterModel: env.OPENROUTER_MODEL,
  openRouterReferer: env.OPENROUTER_REFERER,
  openRouterTitle: env.OPENROUTER_TITLE,
  openRouterProviderZdr: env.OPENROUTER_PROVIDER_ZDR === 'true',
  openRouterProviderOnly: env.OPENROUTER_PROVIDER_ONLY ? env.OPENROUTER_PROVIDER_ONLY.split(',').map(s => s.trim()).filter(Boolean) : [],
  // TTS
  ttsUrl: env.TTS_URL,
  // Personality
  personalitiesDir: env.PERSONALITIES_DIR,
  defaultPersonality: env.DEFAULT_PERSONALITY,
  personalityStatePath: env.PERSONALITY_STATE_PATH,
  // Acknowledgement (voice)
  soundsDir: env.SOUNDS_DIR,
  ackSoundDefault: env.ACK_SOUND_DEFAULT,
  ackEnabledDefault: env.ACK_ENABLED_DEFAULT === 'true',
  // Reminders / triggers
  reminderTimezone: env.REMINDER_TIMEZONE,
  // Chat @-mention → Jarvis (owner only). Kill switch.
  jarvisMentionEnabled: env.JARVIS_MENTION_ENABLED === 'true',
  // Mind dashboard
  dashboardEnabled: env.DASHBOARD_ENABLED === 'true',
  dashboardWsPort: env.DASHBOARD_WS_PORT,
  dashboardHttpPort: env.DASHBOARD_HTTP_PORT,
};
