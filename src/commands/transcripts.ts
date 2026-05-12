import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AttachmentBuilder,
} from 'discord.js';
import { config } from '../config';
import { transcriptStore } from '../voice/transcript-store';
import type { Command } from '../types';

function ownerOnly(interaction: ChatInputCommandInteraction): boolean {
  if (interaction.user.id !== config.ownerId) {
    interaction.reply({ content: '🔒 This command is owner-only.', ephemeral: true });
    return false;
  }
  return true;
}

/** Format ms-from-session-start as mm:ss */
function stamp(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

/** Resolve a userId to a display name via the guild, falling back to the raw id */
async function resolveDisplayName(
  interaction: ChatInputCommandInteraction,
  userId: string,
): Promise<string> {
  try {
    const member = await interaction.guild?.members.fetch(userId);
    return member?.displayName ?? userId;
  } catch {
    return userId;
  }
}

export const transcriptsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('transcripts')
    .setDescription('Query voice transcripts (owner only)')
    .addSubcommand((sub) =>
      sub
        .setName('recent')
        .setDescription('Show the last N transcript lines from the most recent session')
        .addIntegerOption((o) =>
          o.setName('count').setDescription('Number of lines (default 20, max 100)').setMinValue(1).setMaxValue(100),
        )
        .addUserOption((o) =>
          o.setName('user').setDescription('Filter by a specific user'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('session')
        .setDescription('Get the full transcript of a session as a file')
        .addStringOption((o) =>
          o.setName('session_id').setDescription('Session ID (omit for most recent)'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('search')
        .setDescription('Search transcripts by text')
        .addStringOption((o) =>
          o.setName('text').setDescription('Text to search for').setRequired(true),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!ownerOnly(interaction)) return;

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    // ── recent ──────────────────────────────────────────────────────────────
    if (sub === 'recent') {
      await interaction.deferReply({ ephemeral: true });

      const count = interaction.options.getInteger('count') ?? 20;
      const userOption = interaction.options.getUser('user');
      const rows = await transcriptStore.recent(guildId, count, userOption?.id);

      if (rows.length === 0) {
        await interaction.editReply('ℹ️ No transcripts found.');
        return;
      }

      // Resolve display names for all unique userIds
      const userIds = [...new Set(rows.map((r: any) => r.userId as string))];
      const nameMap = new Map<string, string>();
      for (const uid of userIds) {
        nameMap.set(uid, await resolveDisplayName(interaction, uid));
      }

      // Rows come back newest-first; reverse for chronological display
      const lines = [...rows].reverse().map((r: any) =>
        `[${stamp(r.startMs)}] ${nameMap.get(r.userId) ?? r.userId}: ${r.textNormalized}`,
      );

      const body = lines.join('\n');

      if (body.length <= 1900) {
        await interaction.editReply(`\`\`\`\n${body}\n\`\`\``);
      } else {
        const attachment = new AttachmentBuilder(Buffer.from(body, 'utf-8'), {
          name: 'recent.txt',
        });
        await interaction.editReply({ content: `Last ${rows.length} lines:`, files: [attachment] });
      }
      return;
    }

    // ── session ──────────────────────────────────────────────────────────────
    if (sub === 'session') {
      await interaction.deferReply({ ephemeral: true });

      const sessionId = interaction.options.getString('session_id') ?? undefined;
      const { session, rows } = await transcriptStore.session(sessionId, guildId);

      if (!session) {
        await interaction.editReply('ℹ️ No session found.');
        return;
      }

      const userIds = [...new Set(rows.map((r: any) => r.userId as string))];
      const nameMap = new Map<string, string>();
      for (const uid of userIds) {
        nameMap.set(uid, await resolveDisplayName(interaction, uid));
      }

      const header = `# Session ${session.id}\n# Channel: <#${session.channelId}>\n# Started: ${session.startedAt.toISOString()}${session.endedAt ? `\n# Ended: ${session.endedAt.toISOString()}` : ''}\n\n`;
      const lines = rows.map((r: any) =>
        `[${stamp(r.startMs)}] ${nameMap.get(r.userId) ?? r.userId}: ${r.textNormalized}`,
      );
      const body = header + lines.join('\n');

      const attachment = new AttachmentBuilder(Buffer.from(body, 'utf-8'), {
        name: `session-${session.id}.txt`,
      });
      await interaction.editReply({
        content: `Session \`${session.id}\` — ${rows.length} lines.`,
        files: [attachment],
      });
      return;
    }

    // ── search ───────────────────────────────────────────────────────────────
    if (sub === 'search') {
      await interaction.deferReply({ ephemeral: true });

      const text = interaction.options.getString('text', true);
      const rows = await transcriptStore.search(guildId, text);

      if (rows.length === 0) {
        await interaction.editReply(`ℹ️ No results for \`${text}\`.`);
        return;
      }

      const userIds = [...new Set(rows.map((r: any) => r.userId as string))];
      const nameMap = new Map<string, string>();
      for (const uid of userIds) {
        nameMap.set(uid, await resolveDisplayName(interaction, uid));
      }

      const lines = rows.map((r: any) =>
        `[${r.createdAt.toISOString().slice(0, 19)}] ${nameMap.get(r.userId) ?? r.userId}: ${r.textNormalized}`,
      );
      const body = lines.join('\n');

      if (body.length <= 1900) {
        await interaction.editReply(`**Search: \`${text}\`** (${rows.length} results)\n\`\`\`\n${body}\n\`\`\``);
      } else {
        const attachment = new AttachmentBuilder(Buffer.from(body, 'utf-8'), {
          name: 'search-results.txt',
        });
        await interaction.editReply({
          content: `**Search: \`${text}\`** — ${rows.length} results:`,
          files: [attachment],
        });
      }
    }
  },
};
