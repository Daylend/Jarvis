import type { Client } from 'discord.js';
import { transcriptStore } from './transcript-store';

export interface JarvisTool {
  definition: {
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
  requiresApproval?: boolean;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<string>;
}

export interface ToolContext {
  client: Client;
  ownerId: string;
  guildId: string;
  channelId: string;
}

class ToolRegistry {
  private tools = new Map<string, JarvisTool>();

  register(tool: JarvisTool): void {
    const name = tool.definition.function.name;
    if (this.tools.has(name)) {
      console.warn(`[jarvis-tools] Tool "${name}" already registered — overwriting`);
    }
    this.tools.set(name, tool);
    console.log(`[jarvis-tools] Registered tool "${name}"${tool.requiresApproval ? ' (requires approval)' : ''}`);
  }

  get(name: string): JarvisTool | undefined {
    return this.tools.get(name);
  }

  getAll(): JarvisTool[] {
    return [...this.tools.values()];
  }

  getAllDefinitions(): Array<JarvisTool['definition']> {
    return this.getAll().map((t) => t.definition);
  }
}

export const toolRegistry = new ToolRegistry();

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'send_dm',
      description: 'Send a text response as a Discord direct message to the owner. Only use for long responses, lists, code, structured data, or private/sensitive information.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message to send to the owner' },
        },
        required: ['text'],
      },
    },
  },
  async execute(args, context) {
    const text = args.text as string;
    const user = await context.client.users.fetch(context.ownerId);
    for (let i = 0; i < text.length; i += 2000) {
      await user.send(text.slice(i, i + 2000));
    }
    return 'delivered';
  },
});

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'speak_tts',
      description: 'Speak a short response aloud in the voice channel using text-to-speech. Use this for short, conversational replies (1-3 sentences). This is the preferred method for most responses. Do NOT use for long text, code, lists, structured data, or private information.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to speak aloud. Keep it concise and natural-sounding. Plain text only, no markdown or formatting.' },
        },
        required: ['text'],
      },
    },
  },
  async execute(args, context) {
    const text = args.text as string;
    const { sessionManager } = await import('./session-manager');
    const { ttsClient } = await import('./tts-client');

    const ctx = sessionManager.get(context.guildId);
    if (!ctx) {
      return 'Error: no active voice session in this guild. Cannot speak.';
    }

    try {
      await ttsClient.speak(ctx.connection, text, ctx.guildId);
      return 'spoken';
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[jarvis-tools] speak_tts error:`, msg);
      return `TTS error: ${msg}`;
    }
  },
});

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'search_transcripts',
      description:
        'Search past voice chat transcripts by keyword. Returns matching lines with session IDs and timestamps for drilling into specific conversations.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search term to look for in transcripts',
          },
          limit: {
            type: 'number',
            description: 'Max results to return (default 25, max 50)',
          },
        },
        required: ['query'],
      },
    },
  },
  async execute(args, context) {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) || 25, 50);

    const rows = await transcriptStore.search(context.guildId, query, limit);
    if (rows.length === 0) return `No transcripts found matching "${query}".`;

    const results = rows.map((r: any) => ({
      sessionId: r.sessionId,
      timestamp: r.createdAt?.toISOString?.() ?? 'unknown',
      userId: r.userId,
      startMs: r.startMs,
      text: r.textNormalized,
    }));

    const json = JSON.stringify(results, null, 2);
    if (json.length > 3000) {
      const truncated = JSON.stringify(results.slice(0, 10), null, 2);
      return truncated + `\n\n... (${rows.length} total results, showing first 10. Refine your search for more specific results.)`;
    }
    return json;
  },
});

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'list_sessions',
      description:
        'List recent voice chat sessions with metadata. Use this to find session IDs for retrieving full transcripts.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Number of sessions to list (default 10, max 25)',
          },
        },
        required: [],
      },
    },
  },
  async execute(args, context) {
    const limit = Math.min((args.limit as number) || 10, 25);

    const sessions = await transcriptStore.listSessions(context.guildId, limit);
    if (sessions.length === 0) return 'No voice sessions found.';

    const results = sessions.map((s: any) => ({
      id: s.id,
      channelId: s.channelId,
      startedAt: s.startedAt?.toISOString?.() ?? 'unknown',
      endedAt: s.endedAt?.toISOString?.() ?? null,
      lineCount: s._count?.transcripts ?? 0,
    }));

    return JSON.stringify(results, null, 2);
  },
});

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'get_session_transcript',
      description:
        'Get the transcript of a voice session. Can filter by time range within the session using start/end offsets in milliseconds. Omit session_id to get the most recent session.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'Session ID to retrieve (omit for most recent session)',
          },
          start_offset_ms: {
            type: 'number',
            description: 'Only include lines at or after this offset (milliseconds from session start)',
          },
          end_offset_ms: {
            type: 'number',
            description: 'Only include lines at or before this offset (milliseconds from session start)',
          },
          limit: {
            type: 'number',
            description: 'Max lines to return (default 100, max 200)',
          },
        },
        required: [],
      },
    },
  },
  async execute(args, context) {
    const sessionId = args.session_id as string | undefined;
    const startMs = args.start_offset_ms as number | undefined;
    const endMs = args.end_offset_ms as number | undefined;
    const limit = Math.min((args.limit as number) || 100, 200);

    const { session, rows } = await transcriptStore.sessionFiltered(
      context.guildId,
      sessionId,
      startMs,
      endMs,
      limit,
    );

    if (!session) return 'No session found.';

    const header = `Session ${session.id} | Started: ${session.startedAt?.toISOString?.() ?? 'unknown'}${session.endedAt ? ` | Ended: ${session.endedAt.toISOString()}` : ''}\n`;

    if (rows.length === 0) return header + 'No transcript lines in this range.';

    const formatStamp = (ms: number) => {
      const totalSec = Math.floor(ms / 1000);
      const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
      const s = (totalSec % 60).toString().padStart(2, '0');
      return `${m}:${s}`;
    };

    const lines = rows.map(
      (r: any) => `[${formatStamp(r.startMs)}] <@${r.userId}>: ${r.textNormalized}`,
    );

    let result = header + lines.join('\n');
    if (result.length > 3000) {
      result = result.slice(0, 3000) + `\n\n... (truncated, ${rows.length} total lines. Use start_offset_ms/end_offset_ms to narrow the range.)`;
    }
    return result;
  },
});

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'get_context_around',
      description:
        'Get transcript lines surrounding a specific moment in a session. Useful for reading the conversation around a search hit. Provide the session_id and center_offset_ms from search results.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'The session ID to look in',
          },
          center_offset_ms: {
            type: 'number',
            description: 'The offset in milliseconds to center the window on (use startMs from search results)',
          },
          window_minutes: {
            type: 'number',
            description: 'Minutes of context on each side of the center point (default 2)',
          },
        },
        required: ['session_id', 'center_offset_ms'],
      },
    },
  },
  async execute(args, context) {
    const sessionId = args.session_id as string;
    const centerMs = args.center_offset_ms as number;
    const windowMin = Math.min((args.window_minutes as number) || 2, 10);
    const windowMs = windowMin * 60 * 1000;

    const rows = await transcriptStore.aroundOffset(sessionId, centerMs, windowMs);
    if (rows.length === 0) return 'No transcript lines found in this window.';

    const formatStamp = (ms: number) => {
      const totalSec = Math.floor(ms / 1000);
      const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
      const s = (totalSec % 60).toString().padStart(2, '0');
      return `${m}:${s}`;
    };

    const lines = rows.map(
      (r: any) => `[${formatStamp(r.startMs)}] <@${r.userId}>: ${r.textNormalized}`,
    );

    let result = lines.join('\n');
    if (result.length > 3000) {
      result = result.slice(0, 3000) + `\n\n... (truncated, ${rows.length} total lines. Try a smaller window_minutes.)`;
    }
    return result;
  },
});
