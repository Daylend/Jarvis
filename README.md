# PaxFax Discord Bot

PaxFax is a multi-purpose Discord bot built with Node.js, TypeScript, and Prisma (SQLite). It features a unique personality system and AI integration via OpenWebUI.

## Features

### 1. Personality System (@Mentions)
When the bot is mentioned in a text channel:
- **70% Chance**: Replies with an "Angry" response (from database or fallback list).
- **30% Chance**: Replies with a "Funny" quote (from database).
- **AI Override**: If the channel is "unlocked" via `/ai unlock`, the bot will ignore the RNG and respond with AI to all mentions.

### 2. Quote Management (`/quotes`)
Manage the database of quotes used for responses.
- `/quotes add text: "..." type: <Funny|Angry>`: Add a new quote.
- `/quotes remove id: <ID>`: Remove a quote by ID.
- `/quotes list [type: <Funny|Angry>]`: List the last 20 quotes (optionally filtered).
- `/quotes import type: <Funny|Angry> json: ["quote1", "quote2"]`: Bulk import quotes from a JSON array.

### 3. AI Integration (`/ai`)
Chat with LLMs via an OpenWebUI backend.
- `/ai chat provider: <name> prompt: "..." [image]`: Start a new conversation.
  - Displays user prompt and bot response in formatted embeds.
  - Supports image attachments (multimodal).
- **Context Awareness**: If you reply to the bot's AI response, it continues the conversation (maintaining context).
  - **Restriction**: Only the **Owner** can continue conversations via reply, unless the channel is unlocked.

### 4. AI Provider Management (`/provider`)
Manage the AI models available to the bot.
- `/provider add name: <alias> model: <openwebui_model_id>`: Add a provider.
- `/provider remove name: <alias>`: Remove a provider.
- `/provider list`: List all configured providers.

### 5. Channel Locking (`/ai`)
Control AI access in specific channels.
- `/ai unlock provider: <name> minutes: <duration>`: Unlocks the current channel for AI interaction for a set time.
  - Allows **anyone** to use `/ai chat` in this channel.
  - Allows **anyone** to reply to the bot to continue conversations.
  - Forces the bot to respond to **@mentions** with AI instead of quotes.
- `/ai lock`: Manually re-locks the channel (reverting to Owner-only AI and standard @mention behavior).

## Setup & Deployment

### Prerequisites
- Docker & Docker Compose
- Discord Bot Token & Client ID
- OpenWebUI Instance (URL & API Key)

### Environment Variables (`.env`)
```env
DISCORD_TOKEN=your_token
CLIENT_ID=your_client_id
OWNER_USER_ID=your_discord_user_id
DATABASE_URL="file:../data/database.sqlite"
OPENWEBUI_API_URL=http://your-openwebui:3000/api
OPENWEBUI_API_KEY=your_api_key
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
- `src/ai-context.ts`: In-memory cache for conversation history.
- `src/channel-lock.ts`: In-memory manager for channel unlock states.
- `src/voice/`: Voice transcription subsystem.
- `services/asr/`: Python ASR sidecar (whisper.cpp + Silero VAD).
- `prisma/schema.prisma`: Database schema definition.

---

## Voice Transcription

### Overview

When the **owner** joins a voice channel, the bot automatically joins and listens. Audio is captured per-speaker, decoded, and streamed to a Python ASR sidecar running **whisper-large-v3-turbo** with a **Vulkan** backend (AMD GPU). Transcripts are normalized using a BDO term glossary and persisted to SQLite. Saying **"Jarvis, \<command\>"** assembles the last 3 minutes of channel-wide context and dispatches it to a pluggable handler (currently logs; future: llamacpp + TTS).

### Architecture

```
Owner joins VC → VoiceStateUpdate → SessionManager
  → VoiceReceiver (per user) → Opus decode → FFmpeg 16kHz mono
  → ASR WebSocket Client → Python sidecar (Silero VAD + whisper.cpp Vulkan)
  → finals → Term Normalizer → SQLite Transcript
                             → ActionRouter (Jarvis trigger)
```

### New Environment Variables

Add these to your `.env` / `stack.env`:

```env
# ASR sidecar connection
TRANSCRIBE_WS_URL=ws://asr:8765/ws/transcribe
TRANSCRIBE_HTTP_URL=http://asr:8765

# Voice behaviour
AUTO_JOIN_OWNER=true              # Auto-join when owner enters a VC
VOICE_IDLE_TIMEOUT_SEC=900        # Leave after 15 min of silence
TRIGGER_PHRASE=jarvis             # Wake word for action router
JARVIS_CONTEXT_SECONDS=180        # Context window size (seconds)

# ASR sidecar (set in docker-compose or sidecar env)
MODEL_PATH=/app/models/ggml-large-v3-turbo-q5_0.bin
DEVICE=vulkan                     # vulkan | cpu
VAD_THRESHOLD=0.5
END_SILENCE_MS=700
MAX_UTTERANCE_MS=25000
```

### ASR Sidecar Deployment

The sidecar is included in `docker/docker-compose.yml` as the `asr` service. It:
1. Builds `whisper.cpp` with `WHISPER_VULKAN=ON` at image build time.
2. Downloads `ggml-large-v3-turbo-q5_0.bin` (~630 MB) on first start into the `asr-models` volume.
3. Exposes `ws://asr:8765/ws/transcribe` and `http://asr:8765/healthz`.
4. Requires `/dev/dri` device passthrough for AMD GPU Vulkan access.

**To use an external sidecar** (e.g. running on a different host), simply omit the `asr` service from compose and set `TRANSCRIBE_WS_URL` / `TRANSCRIBE_HTTP_URL` to point at the remote.

**First-time model download** happens automatically on container start. To pre-download manually:
```bash
docker run --rm -v /path/to/asr-models:/app/models \
  registry.example.com/paxfax-asr:latest /app/scripts/download-model.sh
```

### New Slash Commands (all owner-only, ephemeral)

#### `/jarvis listen`
| Subcommand | Description |
|---|---|
| `start` | Join your current voice channel and begin transcribing |
| `stop` | Stop the active session in this server |
| `status` | Show session info + ASR sidecar health |

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
