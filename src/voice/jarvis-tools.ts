import type { Client } from 'discord.js';

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
