import type { Client } from 'discord.js';
import { config } from '../config';
import { transcriptStore } from './transcript-store';
import { noteStore } from './note-store';

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

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'save_note',
      description:
        'Save a note for the owner. Always provide a short title (summary) and full content. Use when the owner says "remember X", "note that", or asks you to keep track of something.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short summary of the note (used as an index line in your context)',
          },
          content: {
            type: 'string',
            description: 'Full detail of the note',
          },
        },
        required: ['title', 'content'],
      },
    },
  },
  async execute(args, context) {
    const title = args.title as string;
    const content = args.content as string;
    if (!title.trim() || !content.trim()) {
      return 'Both title and content are required.';
    }
    const note = await noteStore.save(context.guildId, title.trim(), content.trim());
    return `Saved note #${note.id}: "${title}"`;
  },
});

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'search_notes',
      description:
        'Search saved notes by keyword or retrieve a specific note by ID. Use to recall notes the owner has asked you to remember. If you see a note title in your context and need the full content, call this with the note ID.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'number',
            description: 'Retrieve a specific note by its ID number',
          },
          query: {
            type: 'string',
            description: 'Keyword to search for in note titles and content',
          },
          limit: {
            type: 'number',
            description: 'Max results to return (default 10, max 50)',
          },
        },
        required: [],
      },
    },
  },
  async execute(args, context) {
    if (args.id !== undefined) {
      const note = await noteStore.getById(args.id as number, context.guildId);
      if (!note) return `Note #${args.id} not found.`;
      return JSON.stringify({
        id: note.id,
        title: note.title,
        content: note.content,
        createdAt: note.createdAt,
      });
    }

    const query = args.query as string | undefined;
    const limit = Math.min((args.limit as number) || 10, 50);
    const notes = await noteStore.search(context.guildId, query, limit);
    if (notes.length === 0) return query ? `No notes found matching "${query}".` : 'No saved notes.';

    const results = notes.map((n: any) => ({
      id: n.id,
      title: n.title,
      content: n.content,
    }));

    const json = JSON.stringify(results, null, 2);
    if (json.length > 3000) {
      const truncated = JSON.stringify(results.slice(0, 10), null, 2);
      return truncated + `\n\n... (${notes.length} total results, showing first 10. Narrow your search.)`;
    }
    return json;
  },
});

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'delete_note',
      description:
        'Delete a saved note by ID. Use when the owner asks to forget or remove a specific note.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'number',
            description: 'The ID of the note to delete',
          },
        },
        required: ['id'],
      },
    },
  },
  async execute(args, context) {
    const id = args.id as number;
    const deleted = await noteStore.delete(id, context.guildId);
    if (!deleted) return `Note #${id} not found.`;
    return `Deleted note #${id}.`;
  },
});

function formatLocalTime(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: config.reminderTimezone,
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZoneName: 'short',
  }).format(date);
}

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: 'Schedule a time-based reminder or timer. Provide an instruction for what to do when it fires, AND exactly one of delay_seconds (relative) or fire_at (absolute ISO datetime). Optionally set a label for management, repeat_seconds for recurring timers, and skill name to link to a skill.',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'What Jarvis should do when the reminder fires (e.g. "Announce that PA 1 is up")' },
          delay_seconds: { type: 'number', description: 'Seconds from now until the reminder fires (use this OR fire_at, not both)' },
          fire_at: { type: 'string', description: 'Absolute ISO datetime to fire (e.g. "2026-06-03T09:00:00-04:00"). Use this OR delay_seconds, not both.' },
          label: { type: 'string', description: 'Optional short label for tracking (e.g. "pa-1"). Same-label replaces any existing pending reminder.' },
          repeat_seconds: { type: 'number', description: 'Optional: seconds between fires for recurring reminders/polling' },
          skill: { type: 'string', description: 'Optional: skill name to link this trigger to, for lifecycle management' },
        },
        required: ['instruction'],
      },
    },
  },
  async execute(args, context) {
    const instruction = args.instruction as string;
    const delaySeconds = args.delay_seconds as number | undefined;
    const fireAtStr = args.fire_at as string | undefined;
    const label = args.label as string | undefined;
    const repeatSeconds = args.repeat_seconds as number | undefined;
    const skillName = args.skill as string | undefined;

    if (!instruction?.trim()) return 'instruction is required.';

    const hasDelay = delaySeconds !== undefined;
    const hasFireAt = fireAtStr !== undefined;
    if (hasDelay === hasFireAt) {
      return 'Provide exactly one of delay_seconds or fire_at, not both and not neither.';
    }

    let fireAt: Date;
    if (hasDelay) {
      if (typeof delaySeconds !== 'number' || delaySeconds <= 0) {
        return 'delay_seconds must be a positive number.';
      }
      fireAt = new Date(Date.now() + delaySeconds * 1000);
    } else {
      const parsed = parseDate(fireAtStr);
      if (!parsed) return 'Invalid fire_at format. Use ISO datetime, e.g. "2026-06-03T09:00:00-04:00".';
      if (parsed.getTime() <= Date.now()) return 'fire_at is in the past. Provide a future time.';
      fireAt = parsed;
    }

    let skillId: number | null = null;
    if (skillName) {
      const { skillStore } = await import('./skill-store');
      const skill = await skillStore.getByName(config.ownerId, skillName);
      if (skill) skillId = skill.id;
    }

    const { triggerStore } = await import('./trigger-store');
    const { scheduler } = await import('./scheduler');

    if (label) {
      const existing = await triggerStore.findByLabel(config.ownerId, label);
      if (existing) {
        scheduler.cancel(existing.id);
      }
    }

    const row = await triggerStore.create({
      ownerId: config.ownerId,
      guildId: context.guildId || null,
      channelId: context.channelId || null,
      skillId,
      type: 'time',
      label: label || null,
      instruction: instruction.trim(),
      fireAt,
      repeatSeconds: repeatSeconds || null,
    });

    scheduler.schedule(row);
    return `Reminder #${row.id} scheduled${label ? ` "${label}"` : ''}. Fires at ${formatLocalTime(fireAt)}${repeatSeconds ? `, repeating every ${repeatSeconds}s` : ''}.`;
  },
});

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'add_phrase_trigger',
      description: 'Register a phrase trigger that listens for specific phrases in voice chat and dispatches them to the Jarvis pipeline for gating/action. Phrases are matched with word boundaries (e.g. "pa" will NOT match inside "compare").',
      parameters: {
        type: 'object',
        properties: {
          phrases: { type: 'array', items: { type: 'string' }, description: 'List of phrase patterns to match (lowercase, e.g. ["pa is up", "pa\'s up", "casting pa"])' },
          instruction: { type: 'string', description: 'What Jarvis should do when the phrase fires (will be gated — model decides if context genuinely means the event)' },
          speakers: { type: 'string', description: "Who can trigger: 'anyone' (default) or 'owner'" },
          cooldown_seconds: { type: 'number', description: 'Minimum seconds between fires (default 0, min 10 if set)' },
          one_shot: { type: 'boolean', description: 'If true, fires once then auto-cancels' },
          label: { type: 'string', description: 'Optional short label for management' },
          skill: { type: 'string', description: 'Optional: skill name to link this trigger to' },
        },
        required: ['phrases', 'instruction'],
      },
    },
  },
  async execute(args, context) {
    const phrases = args.phrases as string[];
    const instruction = args.instruction as string;
    const speakers = (args.speakers as string) || 'anyone';
    const cooldownSeconds = args.cooldown_seconds as number | undefined;
    const oneShot = args.one_shot as boolean | undefined;
    const label = args.label as string | undefined;
    const skillName = args.skill as string | undefined;

    if (!phrases || phrases.length === 0) return 'phrases array is required.';
    if (!instruction?.trim()) return 'instruction is required.';
    if (speakers !== 'anyone' && speakers !== 'owner') return 'speakers must be "anyone" or "owner".';

    if (cooldownSeconds !== undefined && cooldownSeconds < 10) {
      return 'cooldown_seconds must be at least 10.';
    }

    const { phraseTriggerRegistry } = await import('./phrase-trigger-registry');
    const { triggerStore } = await import('./trigger-store');
    const { skillStore } = await import('./skill-store');

    if (phraseTriggerRegistry.activeCount >= 50) {
      return 'Too many active phrase triggers (max 50). Cancel some before adding more.';
    }

    let skillId: number | null = null;
    if (skillName) {
      const skill = await skillStore.getByName(config.ownerId, skillName);
      if (skill) skillId = skill.id;
    }

    const normPhrases = phrases.map((p: string) => p.toLowerCase().trim());

    const row = await triggerStore.create({
      ownerId: config.ownerId,
      guildId: context.guildId || null,
      channelId: context.channelId || null,
      skillId,
      type: 'phrase',
      label: label || null,
      instruction: instruction.trim(),
      phrases: normPhrases,
      speakers: speakers as 'anyone' | 'owner',
      cooldownSeconds: cooldownSeconds ?? null,
      oneShot: oneShot ?? false,
    });

    phraseTriggerRegistry.add(row);
    return `Phrase trigger #${row.id} registered${label ? ` "${label}"` : ''}. Listening for: ${normPhrases.join(', ')}.`;
  },
});

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'list_triggers',
      description: 'List all active (pending) triggers for the owner. Returns type, label, status, and timing info.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  async execute(args) {
    const { triggerStore } = await import('./trigger-store');
    const rows = await triggerStore.listActive({ ownerId: config.ownerId });
    if (rows.length === 0) return 'No active triggers.';

    const results = rows.map((r: any) => {
      const base: any = { id: r.id, type: r.type, label: r.label ?? null, status: r.status };
      if (r.type === 'time') {
        base.fireAt = r.fireAt ? formatLocalTime(new Date(r.fireAt)) : null;
        base.repeatSeconds = r.repeatSeconds ?? null;
      }
      if (r.type === 'phrase') {
        base.phrases = r.phrases ?? [];
        base.speakers = r.speakers;
        base.cooldownSeconds = r.cooldownSeconds ?? null;
        base.oneShot = r.oneShot;
        base.lastFiredAt = r.lastFiredAt ? formatLocalTime(new Date(r.lastFiredAt)) : null;
      }
      return base;
    });

    return JSON.stringify(results, null, 2);
  },
});

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'cancel_trigger',
      description: 'Cancel an active trigger by id or label. Stops the trigger and marks it as canceled.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Trigger ID to cancel' },
          label: { type: 'string', description: 'Trigger label to cancel' },
        },
        required: [],
      },
    },
  },
  async execute(args) {
    const { triggerStore } = await import('./trigger-store');
    const { scheduler } = await import('./scheduler');
    const { phraseTriggerRegistry } = await import('./phrase-trigger-registry');

    let trigger: any = null;
    if (args.id !== undefined) {
      trigger = await triggerStore.getById(args.id as number);
    } else if (args.label) {
      trigger = await triggerStore.findByLabel(config.ownerId, args.label as string);
    } else {
      return 'Provide id or label to cancel.';
    }

    if (!trigger || trigger.status !== 'active') {
      return `Trigger not found or already inactive.`;
    }

    scheduler.cancel(trigger.id);
    phraseTriggerRegistry.remove(trigger.id);
    return `Trigger #${trigger.id}${trigger.label ? ` "${trigger.label}"` : ''} canceled.`;
  },
});

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'save_skill',
      description: 'Save a reusable skill/playbook. A skill is a named set of instructions Jarvis executes when activated. Use upsert — same name updates the existing skill.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short name for the skill (e.g. "PA tracking")' },
          description: { type: 'string', description: 'Brief one-line description (shown in context so Jarvis knows it exists)' },
          playbook: { type: 'string', description: 'Full instructions Jarvis executes when the skill is started via start_skill. Should describe which triggers/timers to register and how to handle fires.' },
          auto_start: { type: 'boolean', description: 'If true, automatically activate this skill whenever a voice session starts' },
        },
        required: ['name', 'description', 'playbook'],
      },
    },
  },
  async execute(args, context) {
    const name = args.name as string;
    const description = args.description as string;
    const playbook = args.playbook as string;
    const autoStart = args.auto_start as boolean | undefined;

    if (!name?.trim() || !description?.trim() || !playbook?.trim()) {
      return 'name, description, and playbook are all required.';
    }

    const { skillStore } = await import('./skill-store');
    const skill = await skillStore.save({
      ownerId: config.ownerId,
      guildId: context.guildId || null,
      name: name.trim(),
      description: description.trim(),
      playbook: playbook.trim(),
      autoStart: autoStart ?? false,
    });

    return `Skill "${name}" saved (#${skill.id}). Use start_skill "${name}" to activate it.`;
  },
});

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'start_skill',
      description: 'Activate a skill by name. Returns the playbook instructions — read them and execute the steps (register triggers, set timers, etc.) using the available tools. Tag created triggers with skill: "<name>" so stop_skill can tear them down.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the skill to activate' },
        },
        required: ['name'],
      },
    },
  },
  async execute(args) {
    const name = args.name as string;
    if (!name?.trim()) return 'Skill name is required.';

    const { skillStore } = await import('./skill-store');
    const skill = await skillStore.getByName(config.ownerId, name.trim());
    if (!skill) return `Skill "${name}" not found. Use save_skill to create it.`;

    await skillStore.setActive(skill.id, true);
    return `Skill "${name}" activated. Execute these instructions (tag triggers with skill: "${name}"):\n\n${skill.playbook}`;
  },
});

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'stop_skill',
      description: 'Deactivate a skill and cancel ALL triggers it created (phrase triggers and time reminders).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the skill to stop' },
        },
        required: ['name'],
      },
    },
  },
  async execute(args) {
    const name = args.name as string;
    if (!name?.trim()) return 'Skill name is required.';

    const { skillStore } = await import('./skill-store');
    const skill = await skillStore.getByName(config.ownerId, name.trim());
    if (!skill) return `Skill "${name}" not found.`;

    const { triggerStore } = await import('./trigger-store');
    const { scheduler } = await import('./scheduler');
    const { phraseTriggerRegistry } = await import('./phrase-trigger-registry');

    const canceledIds = await triggerStore.cancelBySkill(skill.id);
    for (const id of canceledIds) {
      scheduler.cancelTimer(id);
      phraseTriggerRegistry.remove(id);
    }

    await skillStore.setActive(skill.id, false);
    return `Skill "${name}" stopped. ${canceledIds.length} trigger(s) canceled.`;
  },
});

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'list_skills',
      description: 'List all saved skills with their active status.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  async execute() {
    const { skillStore } = await import('./skill-store');
    const skills = await skillStore.list(config.ownerId);
    if (skills.length === 0) return 'No saved skills.';

    const results = skills.map((s: any) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      active: s.active,
      autoStart: s.autoStart,
    }));
    return JSON.stringify(results, null, 2);
  },
});

toolRegistry.register({
  definition: {
    type: 'function',
    function: {
      name: 'delete_skill',
      description: 'Permanently delete a skill by name. Also cancels any active triggers owned by it.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the skill to delete' },
        },
        required: ['name'],
      },
    },
  },
  async execute(args) {
    const name = args.name as string;
    if (!name?.trim()) return 'Skill name is required.';

    const { skillStore } = await import('./skill-store');
    const skill = await skillStore.getByName(config.ownerId, name.trim());
    if (!skill) return `Skill "${name}" not found.`;

    const { triggerStore } = await import('./trigger-store');
    const { scheduler } = await import('./scheduler');
    const { phraseTriggerRegistry } = await import('./phrase-trigger-registry');

    const canceledIds = await triggerStore.cancelBySkill(skill.id);
    for (const id of canceledIds) {
      scheduler.cancelTimer(id);
      phraseTriggerRegistry.remove(id);
    }

    await skillStore.delete(skill.id);
    return `Skill "${name}" deleted${canceledIds.length > 0 ? ` (${canceledIds.length} triggers canceled)` : ''}.`;
  },
});
