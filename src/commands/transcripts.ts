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

function formatDt(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

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

async function resolveNameMap(
  interaction: ChatInputCommandInteraction,
  rows: any[],
): Promise<Map<string, string>> {
  const userIds = [...new Set(rows.map((r) => r.userId as string))];
  const nameMap = new Map<string, string>();
  for (const uid of userIds) {
    nameMap.set(uid, await resolveDisplayName(interaction, uid));
  }
  return nameMap;
}

async function sendAsFile(
  interaction: ChatInputCommandInteraction,
  body: string,
  name: string,
  summary: string,
): Promise<void> {
  const attachment = new AttachmentBuilder(Buffer.from(body, 'utf-8'), { name });
  await interaction.editReply({ content: summary, files: [attachment] });
}

async function sendOrAttach(
  interaction: ChatInputCommandInteraction,
  body: string,
  summary: string,
  fileName: string,
): Promise<void> {
  if (body.length <= 1900) {
    await interaction.editReply(`\`\`\`\n${body}\n\`\`\``);
  } else {
    await sendAsFile(interaction, body, fileName, summary);
  }
}

export const transcriptsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('transcripts')
    .setDescription('Query voice transcripts (owner only)')
    .addSubcommand((sub) =>
      sub
        .setName('search')
        .setDescription('Search transcripts by keyword with optional filters')
        .addStringOption((o) =>
          o.setName('text').setDescription('Text to search for').setRequired(true),
        )
        .addUserOption((o) =>
          o.setName('user').setDescription('Filter by a specific user'),
        )
        .addStringOption((o) =>
          o.setName('session_id').setDescription('Filter by session ID'),
        )
        .addStringOption((o) =>
          o.setName('after').setDescription('Only results after this datetime (e.g. "2025-01-15" or "2025-01-15 14:00")'),
        )
        .addStringOption((o) =>
          o.setName('before').setDescription('Only results before this datetime'),
        )
        .addIntegerOption((o) =>
          o.setName('limit').setDescription('Max results (default 10, max 50)').setMinValue(1).setMaxValue(50),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('get')
        .setDescription('Get transcript lines with optional filters')
        .addIntegerOption((o) =>
          o.setName('around_id').setDescription('Transcript ID to center around (from search results)').setMinValue(1),
        )
        .addStringOption((o) =>
          o.setName('session_id').setDescription('Restrict to a specific session'),
        )
        .addUserOption((o) =>
          o.setName('user').setDescription('Filter by a specific user'),
        )
        .addStringOption((o) =>
          o.setName('after').setDescription('Only lines after this datetime'),
        )
        .addStringOption((o) =>
          o.setName('before').setDescription('Only lines before this datetime'),
        )
        .addIntegerOption((o) =>
          o.setName('limit').setDescription('Number of lines (default 10, max 200)').setMinValue(1).setMaxValue(200),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('sessions')
        .setDescription('List recent voice sessions')
        .addIntegerOption((o) =>
          o.setName('limit').setDescription('Number of sessions (default 10, max 25)').setMinValue(1).setMaxValue(25),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('session')
        .setDescription('Get the full transcript of a session as a file attachment')
        .addStringOption((o) =>
          o.setName('session_id').setDescription('Session ID (omit for most recent)'),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!ownerOnly(interaction)) return;

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    if (sub === 'search') {
      await interaction.deferReply({ ephemeral: true });

      const text = interaction.options.getString('text', true);
      const userOption = interaction.options.getUser('user');
      const sessionId = interaction.options.getString('session_id') ?? undefined;
      const limit = interaction.options.getInteger('limit') ?? 10;

      const after = parseDate(interaction.options.getString('after') ?? undefined);
      const before = parseDate(interaction.options.getString('before') ?? undefined);

      if ((interaction.options.getString('after') && !after) ||
          (interaction.options.getString('before') && !before)) {
        await interaction.editReply('⚠️ Invalid date format. Use e.g. "2025-01-15" or "2025-01-15 14:00".');
        return;
      }
      if (after && before && after > before) {
        await interaction.editReply('⚠️ Invalid range: after is later than before.');
        return;
      }

      const rows = await transcriptStore.search({
        guildId,
        query: text,
        userId: userOption?.id,
        sessionId,
        after: after ?? undefined,
        before: before ?? undefined,
        limit,
      });

      if (rows.length === 0) {
        await interaction.editReply(`ℹ️ No results for \`${text}\`.`);
        return;
      }

      const nameMap = await resolveNameMap(interaction, rows);
      const lines = rows.map((r: any) =>
        `#${r.id} [${formatDt(r.createdAt)}] ${nameMap.get(r.userId) ?? r.userId}: ${r.textNormalized}`,
      );
      const body = lines.join('\n');
      await sendOrAttach(interaction, body, `**Search: \`${text}\`** — ${rows.length} results:`, 'search-results.txt');
      return;
    }

    if (sub === 'get') {
      await interaction.deferReply({ ephemeral: true });

      const aroundId = interaction.options.getInteger('around_id') ?? undefined;
      const userOption = interaction.options.getUser('user');
      const sessionId = interaction.options.getString('session_id') ?? undefined;
      const limit = interaction.options.getInteger('limit') ?? 10;

      const after = parseDate(interaction.options.getString('after') ?? undefined);
      const before = parseDate(interaction.options.getString('before') ?? undefined);

      if ((interaction.options.getString('after') && !after) ||
          (interaction.options.getString('before') && !before)) {
        await interaction.editReply('⚠️ Invalid date format. Use e.g. "2025-01-15" or "2025-01-15 14:00".');
        return;
      }
      if (after && before && after > before) {
        await interaction.editReply('⚠️ Invalid range: after is later than before.');
        return;
      }

      const rows = await transcriptStore.getTranscripts({
        guildId,
        aroundId,
        sessionId,
        userId: userOption?.id,
        after: after ?? undefined,
        before: before ?? undefined,
        limit,
      });

      if (rows.length === 0) {
        await interaction.editReply('ℹ️ No transcripts found.');
        return;
      }

      const nameMap = await resolveNameMap(interaction, rows);
      const lines = rows.map((r: any) =>
        `#${r.id} [${formatDt(r.createdAt)}] ${nameMap.get(r.userId) ?? r.userId}: ${r.textNormalized}`,
      );
      const body = lines.join('\n');
      const summary = `${rows.length} transcript lines${aroundId ? ` around #${aroundId}` : ''}:`;
      await sendOrAttach(interaction, body, summary, 'transcripts.txt');
      return;
    }

    if (sub === 'sessions') {
      await interaction.deferReply({ ephemeral: true });

      const limit = Math.min(interaction.options.getInteger('limit') ?? 10, 25);
      const sessions = await transcriptStore.listSessions(guildId, limit);

      if (sessions.length === 0) {
        await interaction.editReply('ℹ️ No voice sessions found.');
        return;
      }

      const lines = sessions.map((s: any) =>
        `${s.id} | Started: ${formatDt(s.startedAt)}${s.endedAt ? ` | Ended: ${formatDt(s.endedAt)}` : ' | Active'} | ${s._count?.transcripts ?? 0} lines`,
      );
      const body = lines.join('\n');
      await sendOrAttach(interaction, body, `${sessions.length} sessions:`, 'sessions.txt');
      return;
    }

    if (sub === 'session') {
      await interaction.deferReply({ ephemeral: true });

      const sessionId = interaction.options.getString('session_id') ?? undefined;
      const { session, rows } = await transcriptStore.session(sessionId, guildId);

      if (!session) {
        await interaction.editReply('ℹ️ No session found.');
        return;
      }

      const nameMap = await resolveNameMap(interaction, rows);

      const header = `# Session ${session.id}\n# Channel: <#${session.channelId}>\n# Started: ${formatDt(session.startedAt)}${session.endedAt ? `\n# Ended: ${formatDt(session.endedAt)}` : ''}\n\n`;
      const lines = rows.map((r: any) =>
        `[${formatDt(r.createdAt)}] ${nameMap.get(r.userId) ?? r.userId}: ${r.textNormalized}`,
      );
      const body = header + lines.join('\n');

      await sendAsFile(interaction, body, `session-${session.id}.txt`, `Session \`${session.id}\` — ${rows.length} lines.`);
    }
  },
};
