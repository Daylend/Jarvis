# Jarvis

Self-hosted, local-first voice AI for Discord. Jarvis sits in voice channels,
transcribes every speaker independently, wakes on hearing his name, reasons
about the conversation with locally hosted LLMs, and answers out loud, with
an optional live telemetry dashboard watching him do it.

No managed services: transcription, inference, and speech synthesis run on
your own hardware, deployed by your own CI.

## Highlights

- **Per-speaker voice transcription.** Every participant gets an independent
  Opus stream, decoded by a custom Node Transform (`OpusTo16kMonoStream`)
  that bypasses FFmpeg entirely: decode, 3:1 decimation, and channel
  averaging in pure JS.
- **Transcription-based wake word.** "Jarvis, <command>" dispatches early
  off *partial* transcripts for latency, with dedupe/correction once finals
  land. Semantic end-of-turn detection (Smart Turn, ONNX) keeps commits
  honest.
- **Agentic tool loop.** 19 function-calling tools (transcript search,
  notes, reminders, phrase triggers, skills/playbooks) with
  context-gated availability per channel type, bounded iterations, and a
  Discord approve/deny approval-gate framework.
- **Three swappable local TTS engines with voice cloning** (F5-TTS,
  Chatterbox Turbo, and dots.tts) running on AMD ROCm.
- **Local-first LLM inference.** llama.cpp's OpenAI-compatible API with SSE
  streaming; an MoE chat model chosen for voice latency; optional
  OpenRouter fallback (zero-data-retention flagged).
- **"Mind" dashboard.** A SvelteKit app streaming the model's live state:
  TTFT, tokens/sec, tool request/result feed, the system prompt, and the
  transient context, scrubbing through past inference slices.
- **Full CI/CD.** GitLab CI with rootless BuildKit builds seven images to a
  private self-hosted registry; Watchtower auto-deploys them.

## Architecture

```
Discord voice
  └─ per-user Opus streams ──► OpusTo16kMonoStream (no FFmpeg)
       └─ WebSocket ──► ASR sidecar (FastAPI)
                         Silero VAD · Smart Turn endpointing · ring buffers
                         engines: granite-speech-4.1-2b · qwen3-asr-1.7b
                                   (llama.cpp HTTP) · whisper-large-v3-turbo
                                   (ROCm / torch)
       └─ transcripts ──► SQLite (Prisma) ──► Mind dashboard (WS event bus)
       └─ "Jarvis, ..." ──► action router assembles 90s of channel context
             └─► LLM loop (llama.cpp /v1, SSE, 19 tools)
                   └─► speak_tts ──► TTS sidecar
                         F5-TTS · Chatterbox Turbo · dots.tts (ROCm)
```

Service topology (Docker Compose): `bot` (TypeScript, discord.js), `asr`
(Python FastAPI), `tts` (Python FastAPI), `llama-cpp` (model server),
`dashboard` (SvelteKit 5). The dashboard container acts as a gateway,
reverse-proxying the bot's WebSocket bus and HTTP API.

## The voice loop

1. When the owner joins a voice channel, Jarvis auto-joins and subscribes
   to each speaking user's stream.
2. Audio flows through the custom Opus transform to the ASR sidecar, where
   Silero VAD segments speech and an engine transcribes it. Transcripts are
   term-normalized (runtime-editable glossary) and persisted to SQLite.
3. The wake word is matched on final transcripts with word boundaries; with
   early dispatch enabled, the command fires off a partial transcript about
   two seconds after the wake word appears, reconciling when the final lands.
4. The action router assembles the last 90 seconds of all-speaker channel
   context (`[mm:ss] Name: text`) and hands it to the LLM loop.
5. The model must answer through a delivery tool (`speak_tts`, `send_dm`,
   or `reply_in_chat`); the bot holds Discord's green speaking indicator
   through LLM thinking via a silent audio stream, then speaks the reply.

## Agent loop and tools

- **19 tools**, each declaring `available(ctx)`: the model only sees tools
  usable from voice, DMs, mentions, or triggers.
- Bounded loop: up to 20 iterations, early exit once a delivery tool fires;
  131k-token context budget with estimation-based trimming; tool calls and
  history persisted to SQLite.
- **Approval gates:** tools can opt into `requiresApproval`, rendering
  Discord approve/deny buttons with a 30s timeout.
- **Skills** are named playbooks stored in SQLite the model can save, start,
  and stop; skills may register **phrase triggers** (word-boundary matched,
  cooldowns, one-shot, LLM-gated firing) and **time triggers** via a
  scheduler, torn down with their skill.

## Speech stack

| Layer | Options | Runtime |
|---|---|---|
| ASR | granite-speech-4.1-2b (default), qwen3-asr-1.7b | llama.cpp HTTP (`/v1/audio/transcriptions`) |
| ASR | whisper-large-v3-turbo | local ROCm GPU (transformers) |
| TTS | F5-TTS (default, vocos), Chatterbox Turbo, dots.tts | local ROCm GPU, voice-cloned from a reference sample |

The granite ASR image is `python:3.12-slim` with no torch, because inference
is delegated to the shared llama.cpp server, keeping service containers
small. The Whisper/TTS images pin torch to the ROCm version with MIOpen
tuning for the conv decoders.

## CI/CD and deployment

- **Build:** GitLab CI with rootless BuildKit (`moby/buildkit:rootless`)
  builds seven images (bot, dashboard, asr-granite, asr-whisper, tts,
  tts-chatterbox, tts-dots), tagged `$CI_COMMIT_SHA` + `latest`, pushed to a
  private self-hosted registry. Per-path build rules: the bot builds on any
  change; sidecars only build when their paths change. A manual job reclaims
  multi-GB ROCm layer caches.
- **Deploy:** Watchtower polls image digests on the remote host. A `BUILD_SHA`
  label is baked into the bot image so even fully-cached builds produce a new
  digest and trigger deploys.
- **Compose:** base + overlay pattern: pick ASR/TTS engines at compose time
  (`docker/docker-compose.yml` + `docker/docker-compose.granite.yml` or
  `docker/docker-compose.whisper.yml`), with matching `.deploy.*.yml`
  overlays for production.

## Security notes

- Owner-only by design: slash commands are ephemeral and owner-gated; the
  dashboard sits behind a reverse proxy; voice sessions follow the owner.
- Containers run as non-root with `PUID`/`PGID` remapping via `su-exec`.
- Secrets only through environment and CI variables, never in compose files
  or the repo.
- The OpenRouter fallback backend uses a zero-data-retention flag and
  provider allowlist.
- Path-traversal guard on the TTS voice reference resolution.

## Personality

Yes, he has one. Personas are defined in YAML (`personalities/jarvis.yaml`):
few-shot examples, a voice reference for cloning, and ack sounds played on
wake. Non-owner @mentions get a quote from the database (rude 70% of the
time, funny 30%) managed via `/quotes`. Editable at runtime.

## Setup

Prerequisites: Docker + Docker Compose, a Discord bot token and client ID.

```bash
cp .env .env.local   # then fill in DISCORD_TOKEN, CLIENT_ID, OWNER_USER_ID
docker compose -f docker/docker-compose.yml -f docker/docker-compose.granite.yml up -d
```

Core env vars (see `config.ts`, all zod-validated):

```env
DISCORD_TOKEN=...
CLIENT_ID=...
OWNER_USER_ID=...
TRANSCRIBE_WS_URL=ws://asr:8765/ws/transcribe
LLAMA_CPP_URL=http://llama-cpp:8080/v1
TRIGGER_PHRASE=jarvis
JARVIS_CONTEXT_SECONDS=90
JARVIS_LLM_BACKEND=local        # local | openrouter
```

Run migrations and register slash commands: handled idempotently by the
container entrypoint (`prisma migrate deploy` + command registration).

### Commands (owner-only, ephemeral)

| Command | What it does |
|---|---|
| `/jarvis listen start\|stop\|status` | Control the voice session; shows ASR sidecar health |
| `/jarvis llm show\|models\|thinking\|set` | Inspect and switch LLM backend/model/thinking mode |
| `/jarvis ack show\|list\|set\|upload\|enable\|test` | Manage wake acknowledgement sounds |
| `/transcripts recent\|session\|search` | Pull and search persisted transcripts |
| `/quotes add\|remove\|list\|import` | Manage the quote database |
| `/terms add\|remove\|list` | Extend the transcript glossary at runtime |

## License

MIT. See [LICENSE](LICENSE).