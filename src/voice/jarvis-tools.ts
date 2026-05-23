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
  clearHistory?: () => void;
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

function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function formatDt(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'search_transcripts',
      description:
        'Search past voice chat transcripts by keyword. Returns matching lines with transcript IDs, session IDs, and timestamps. Use the returned transcript IDs with get_transcripts to read surrounding conversation.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search term to look for in transcripts',
          },
          user_id: {
            type: 'string',
            description: 'Filter results to a specific Discord user ID',
          },
          session_id: {
            type: 'string',
            description: 'Filter results to a specific voice session ID',
          },
          after: {
            type: 'string',
            description: 'Only include results from after this ISO datetime (e.g. "2025-01-15T14:00:00Z" or "2025-01-15")',
          },
          before: {
            type: 'string',
            description: 'Only include results from before this ISO datetime',
          },
          limit: {
            type: 'number',
            description: 'Max results to return (default 10, max 50)',
          },
        },
        required: ['query'],
      },
    },
  },
  async execute(args, context) {
    const query = args.query as string;
    const userId = args.user_id as string | undefined;
    const sessionId = args.session_id as string | undefined;
    const limit = Math.min((args.limit as number) || 10, 50);

    const after = parseDate(args.after as string | undefined);
    const before = parseDate(args.before as string | undefined);
    if ((args.after && !after) || (args.before && !before)) {
      return 'Invalid date format. Use ISO datetime, e.g. "2025-01-15T14:00:00Z" or "2025-01-15".';
    }
    if (after && before && after > before) {
      return 'Invalid time range: after is later than before.';
    }

    const rows = await transcriptStore.search({
      guildId: context.guildId,
      query,
      userId,
      sessionId,
      after: after ?? undefined,
      before: before ?? undefined,
      limit,
    });

    if (rows.length === 0) return `No transcripts found matching "${query}".`;

    const results = rows.map((r: any) => ({
      id: r.id,
      sessionId: r.sessionId,
      userId: r.userId,
      timestamp: formatDt(r.createdAt),
      text: r.textNormalized,
    }));

    const json = JSON.stringify(results, null, 2);
    if (json.length > 3000) {
      const truncated = JSON.stringify(results.slice(0, 10), null, 2);
      return truncated + `\n\n... (${rows.length} total results, showing first 10. Narrow your search with filters.)`;
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
      name: 'get_transcripts',
      description:
        'Get transcript lines from past voice conversations. Can center around a specific transcript ID (from search_transcripts results) or around a datetime. Use this after search_transcripts to read the conversation surrounding a hit. Start with limit 5-10, then expand to 30 if you need more context.',
      parameters: {
        type: 'object',
        properties: {
          around_id: {
            type: 'number',
            description: 'Transcript ID to center results around. Use the "id" field from search_transcripts results to expand the conversation around a specific hit.',
          },
          around_time: {
            type: 'string',
            description: 'ISO datetime to center results around (e.g. "2025-01-15T14:32:00Z"). Use this to browse conversations by time.',
          },
          session_id: {
            type: 'string',
            description: 'Restrict results to a specific voice session',
          },
          user_id: {
            type: 'string',
            description: 'Filter results to a specific Discord user ID',
          },
          after: {
            type: 'string',
            description: 'Only include lines from after this ISO datetime',
          },
          before: {
            type: 'string',
            description: 'Only include lines from before this ISO datetime',
          },
          limit: {
            type: 'number',
            description: 'Number of transcript lines to return (default 10, max 200). Use 5-10 for a quick look, 30+ to see full conversation context.',
          },
        },
        required: [],
      },
    },
  },
  async execute(args, context) {
    const aroundId = args.around_id as number | undefined;
    const limit = Math.min((args.limit as number) || 10, 200);

    const aroundTime = parseDate(args.around_time as string | undefined);
    const after = parseDate(args.after as string | undefined);
    const before = parseDate(args.before as string | undefined);

    if (args.around_time && !aroundTime) {
      return 'Invalid around_time format. Use ISO datetime, e.g. "2025-01-15T14:00:00Z".';
    }
    if ((args.after && !after) || (args.before && !before)) {
      return 'Invalid date format. Use ISO datetime, e.g. "2025-01-15T14:00:00Z".';
    }
    if (after && before && after > before) {
      return 'Invalid time range: after is later than before.';
    }

    const rows = await transcriptStore.getTranscripts({
      guildId: context.guildId,
      aroundId,
      aroundTime: aroundTime ?? undefined,
      sessionId: args.session_id as string | undefined,
      userId: args.user_id as string | undefined,
      after: after ?? undefined,
      before: before ?? undefined,
      limit,
    });

    if (rows.length === 0) return 'No transcripts found.';

    const lines = rows.map(
      (r: any) => `#${r.id} [${formatDt(r.createdAt)}] ${r.userId}: ${r.textNormalized}`,
    );

    let result = lines.join('\n');
    if (result.length > 3000) {
      result = result.slice(0, 3000) + `\n\n... (truncated, ${rows.length} total lines. Use filters or a smaller limit to narrow the range.)`;
    }
    return result;
  },
});

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'clear_memory',
      description:
        'Clear your conversation memory and start fresh. Use when the owner asks you to forget, reset, or wipe context. This does NOT delete stored transcripts — only your current conversation context.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  async execute(_args, context) {
    if (context.clearHistory) {
      context.clearHistory();
      return 'Memory cleared. Starting fresh.';
    }
    return 'Memory clear not available in this context.';
  },
});
