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
- `prisma/schema.prisma`: Database schema definition.
