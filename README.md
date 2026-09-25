# Jarvis Discord Bot

Jarvis is a voice-first Discord assistant built with Node.js, TypeScript, and Prisma (SQLite). It centers on live voice transcription, an LLM-driven assistant (Jarvis), and TTS, with a quippy quote personality for non-owner @mentions.

## Features

### 1. Personality System (@Mentions)
When the bot is mentioned in a text channel:
- **Owner mention**: When the **owner** @mentions the bot, it routes through the Jarvis LLM loop (sharing conversation history with DMs and voice). Toggled by `JARVIS_MENTION_ENABLED`.
- **Anyone else**: **70% Chance**: Replies with an "Angry" response (from database or fallback list). **30% Chance**: Replies with a "Funny" quote (from database).

### 2. Quote Management (`/quotes`)
Manage the database of quotes used for responses.
- `/quotes add text: "..." type: <Funny|Angry>`: Add a new quote.
- `/quotes remove id: <ID>`: Remove a quote by ID.
- `/quotes list [type: <Funny|Angry>]`: List the last 20 quotes (optionally filtered).
- `/quotes import type: <Funny|Angry> json: ["quote1", "quote2"]`: Bulk import quotes from a JSON array.

## Setup & Deployment

### Prerequisites
- Docker & Docker Compose
- Discord Bot Token & Client ID

### Environment Variables (`.env`)
```env
DISCORD_TOKEN=your_token
CLIENT_ID=your_client_id
OWNER_USER_ID=your_discord_user_id
DATABASE_URL="file:../data/database.sqlite"
```

### Running with Docker
The project includes a `docker-compose.yml` for local development and `docker/docker-compose.deploy.yml` for production.

1.  **Build and Run**:
    ```bash
    docker-compose up -d --build
    ```
2.  **Data Persistence**:
    - Database is stored in `./data/database.sqlite`.
    - Logs are stored in `./logs`.

### Development
- **Install Dependencies**: `npm install`
- **Database Migration**: `npx prisma migrate dev`
- **Run Locally**: `npm run dev`
- **Deploy Commands**: `npm run deploy` (Automatically handled in Docker entrypoint)

## Project Structure
- `src/commands/`: Slash command definitions.
- `src/events/`: Event handlers (though currently mostly in `index.ts`).
- `src/db.ts`: Prisma client instance.
- `src/voice/conversation-store.ts`: Persisted conversation history (SQLite) shared across DM, voice, and @-mention entry points.
- `src/voice/`: Voice transcription subsystem.
- `services/asr/`: Python ASR sidecar with pluggable engines (Granite, Whisper).
- `prisma/schema.prisma`: Database schema definition.
- `sounds/`: Acknowledgement sound files (mounted at `/app/sounds`).

---

## Voice Transcription

### Overview

When the **owner** joins a voice channel, the bot automatically joins and listens. Audio is captured per-speaker, decoded, and streamed to a Python ASR sidecar. The sidecar uses **Silero VAD** for segmentation and a **pluggable engine** for transcription. Transcripts are normalized using a term glossary and persisted to SQLite. Saying **"Jarvis, \<command\>"** assembles the last 3 minutes of channel-wide context and dispatches it to a pluggable handler.

### Architecture

```
Owner joins VC → VoiceStateUpdate → SessionManager
  → VoiceReceiver (per user) → Opus decode → FFmpeg 16kHz mono
  → ASR WebSocket Client → Python sidecar (Silero VAD + engine)
  → finals → Term Normalizer → SQLite Transcript
                             → ActionRouter (Jarvis trigger)
```

### ASR Engines

The sidecar supports swappable transcription backends via `ASR_ENGINE` (env var):

| Engine | Default | Model | Backend |
|---|---|---|---|
| `granite` | ✅ | granite-speech-4.1-2b | llama-cpp HTTP (`/v1/audio/transcriptions`) |
| `qwen3` | | qwen3-asr-1.7b | llama-cpp HTTP (`/v1/audio/transcriptions`) |
| `whisper` | | `openai/whisper-large-v3-turbo` | Local ROCm GPU (transformers) |

Only the selected engine is imported at runtime — selecting `granite` never loads torch-whisper.

### Environment Variables

```env
# ASR sidecar connection
TRANSCRIBE_WS_URL=ws://asr:8765/ws/transcribe
TRANSCRIBE_HTTP_URL=http://asr:8765

# Voice behaviour
AUTO_JOIN_OWNER=true
VOICE_IDLE_TIMEOUT_SEC=900
TRIGGER_PHRASE=jarvis
JARVIS_CONTEXT_SECONDS=180
JARVIS_MENTION_ENABLED=true           # Route owner @-mentions through Jarvis LLM (shared history)
JARVIS_MENTION_CONTEXT_MESSAGES=50    # Recent text-channel msgs pulled as transient context on owner @mention

# LLM Backend Configuration
LLAMA_CPP_URL=http://llama-cpp:8080/v1
LLAMA_CPP_MODEL=local                 # Model to use with llama.cpp. Set to specific model name when using llama.cpp router mode (default: local)
LLM_THINKING=false                    # Enable or disable thinking mode (enable_thinking: true/false in chat_template_kwargs)
JARVIS_LLM_BACKEND=local              # local | openrouter
OPENROUTER_API_KEY=                   # Required for OpenRouter backend
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet
```

**Sidecar env vars:**

```env
ASR_ENGINE=granite                     # granite | qwen3 | whisper (default: granite)

# Granite / OpenAI-compatible
ASR_OPENAI_BASE_URL=http://llama-cpp:8080/v1
ASR_GRANITE_MODEL=/models/granite-speech-4.1-2b-Q6_K.gguf
ASR_GRANITE_PROMPT=transcribe the speech with proper punctuation and capitalization.
ASR_GRANITE_MAX_CONCURRENCY=4
ASR_GRANITE_TIMEOUT_S=30

# Qwen3-ASR (when ASR_ENGINE=qwen3; same llama-cpp endpoint as Granite)
# No instruction prompt is sent (the chat template handles prompting); the raw
# output's `language <X><asr_text>` marker is stripped by the engine. No
# server-side language forcing — the model auto-detects language.
ASR_QWEN3_MODEL=/models/qwen3-asr-1.7b.gguf
ASR_QWEN3_MAX_CONCURRENCY=4
ASR_QWEN3_TIMEOUT_S=30

# Whisper (when ASR_ENGINE=whisper)
ASR_MODEL_ID=openai/whisper-large-v3-turbo
ASR_DEVICE=cuda:0
ASR_DTYPE=float16

# VAD / endpointing (shared)
ASR_VAD_THRESHOLD=0.50
ASR_VAD_MIN_SILENCE_MS=500
ASR_VAD_SPEECH_PAD_MS=300
ASR_MAX_UTTERANCE_S=10.0
ASR_ENDPOINT_IDLE_MS=1200
ASR_ENDPOINT_SILENCE_MS=600
```

### ASR Sidecar Deployment

The sidecar uses a base + overlay compose pattern. Example for Granite:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.granite.yml up
```

For Whisper (requires ROCm GPU):

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.whisper.yml up
```

For Qwen3-ASR, reuse the Granite overlay (same llama-cpp endpoint) and override the engine/model:

```bash
ASR_ENGINE=qwen3 ASR_QWEN3_MODEL=/models/qwen3-asr-1.7b.gguf \
  docker compose -f docker/docker-compose.yml -f docker/docker-compose.granite.yml up
```

The sidecar exposes `ws://asr:8765/ws/transcribe` and `http://asr:8765/healthz`.

### New Slash Commands (all owner-only, ephemeral)

#### `/jarvis listen`
| Subcommand | Description |
|---|---|
| `start` | Join your current voice channel and begin transcribing |
| `stop` | Stop the active session in this server |
| `status` | Show session info + ASR sidecar health |

#### `/jarvis llm`
| Subcommand | Options | Description |
|---|---|---|
| `show` | | Show the active LLM backend, selected model name, thinking status, and backend readiness |
| `models` | | List available local models on the llama.cpp router and their status (e.g., loaded, unloaded, sleeping) |
| `thinking` | `enabled` | Toggle thinking mode on or off (`enable_thinking: true/false` passed to llama.cpp templates) |
| `set` | `backend` `[model]` | Switch backend (`local` or `openrouter`) and optionally set the model name (supports autocomplete for local models in router mode) |

#### `/transcripts`
| Subcommand | Options | Description |
|---|---|---|
| `recent` | `[count=20]` `[user]` | Last N lines from the most recent session |
| `session` | `[session_id]` | Full transcript as a `.txt` file attachment |
| `search` | `text` (required) | Case-insensitive substring search, up to 25 results |

#### `/terms`
| Subcommand | Options | Description |
|---|---|---|
| `add` | `canonical` `alias` | Add a BDO term alias (e.g. `media` → `Mediah`) |
| `remove` | `id_or_alias` | Remove by numeric ID or alias string |
| `list` | `[page=1]` | Paginated listing of all aliases |

### BDO Term Normalization

On first startup, `src/bdo-terms.seed.json` is seeded into the `TermAlias` table. The normalizer applies whole-word, case-insensitive replacements to every final transcript segment before persisting. Use `/terms add` to extend the glossary at runtime without restarting.

### Jarvis Action Router

When the owner says **"Jarvis, \<command\>"** in a voice channel:
1. The action router extracts the command text (everything after "jarvis").
2. It fetches all transcripts from the last `JARVIS_CONTEXT_SECONDS` seconds in the same channel (all speakers).
3. It assembles a formatted context block: `[mm:ss] <@userId>: text`.
4. The payload `{ command, contextBlock }` is passed to a pluggable handler.

**Current handler:** logs to console.
**Future hook:** set `actionRouter.setHandler(async ({ command, contextBlock }) => { /* call llamacpp */ })` in `src/index.ts`.

---

## Voice Acknowledgement (ack)

When Jarvis is triggered by hearing his name in a voice channel — either the owner's wake word ("Jarvis, …") or a public phrase trigger whose utterance contains the wake word — he acknowledges it:

1. After the speaker finishes (ASR final transcript), the **ack sound** plays in the voice channel and Discord's **speaking indicator turns green**.
2. The green indicator **holds continuously through LLM thinking** via a silent audio stream (no audible noise).
3. When Jarvis finishes speaking (TTS) or the loop ends, the indicator turns off.

DM Jarvis messages and time/skill triggers do **not** ack (no one is waiting in voice).

### Sounds folder
Ack sounds live in the mounted `sounds/` folder (`/app/sounds` in the container). A seed sound (`06_web_fan_195hz.wav`) is bundled in the image and auto-seeded into an empty host folder on first start. Supported formats: `.wav .mp3 .flac .ogg .m4a .opus`.

### Personality settings (optional)
A personality YAML may declare ack defaults:

```yaml
ack_sound: 06_web_fan_195hz.wav   # filename in sounds/
ack_enabled: true                  # toggle ack for this personality
```

Runtime overrides (from the Discord commands below) are stored in `personality-state.json` and take precedence over the YAML; the YAML is never modified.

### `/jarvis ack` (owner-only, ephemeral)
| Subcommand | Options | Description |
|---|---|---|
| `show` | | Show the active personality ack config (enabled, sound, file status, source) |
| `list` | | List audio files in the sounds folder |
| `set` | `name` (required, autocomplete) | Pick an existing sound from the folder for the active personality |
| `upload` | `file` attachment (required) | Upload a new sound, save it to the folder, and set it for the active personality |
| `enable` | `enabled` (required) | Toggle ack on/off for the active personality |
| `test` | | Play the current ack sound once in your voice channel |
