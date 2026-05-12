import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { config } from '../config';
import { prisma } from '../db';
import { normalizer } from '../voice/normalizer';
import type { Command } from '../types';

function ownerOnly(interaction: ChatInputCommandInteraction): boolean {
  if (interaction.user.id !== config.ownerId) {
    interaction.reply({ content: '🔒 This command is owner-only.', ephemeral: true });
    return false;
  }
  return true;
}

const PAGE_SIZE = 20;

export const termsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('terms')
    .setDescription('Manage BDO term normalization aliases (owner only)')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a new alias → canonical mapping')
        .addStringOption((o) =>
          o.setName('canonical').setDescription('The correct term (e.g. Mediah)').setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('alias').setDescription('The alias to replace (e.g. media)').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove an alias by its ID or alias string')
        .addStringOption((o) =>
          o.setName('id_or_alias').setDescription('Numeric ID or alias string').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('List all term aliases')
        .addIntegerOption((o) =>
          o.setName('page').setDescription('Page number (default 1)').setMinValue(1),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!ownerOnly(interaction)) return;

    const sub = interaction.options.getSubcommand();

    // ── add ──────────────────────────────────────────────────────────────────
    if (sub === 'add') {
      await interaction.deferReply({ ephemeral: true });

      const canonical = interaction.options.getString('canonical', true).trim();
      const alias = interaction.options.getString('alias', true).trim().toLowerCase();

      try {
        await (prisma as any).termAlias.upsert({
          where: { canonical_alias: { canonical, alias } },
          create: { canonical, alias, createdBy: interaction.user.id },
          update: {},
        });
        await normalizer.invalidate();
        await interaction.editReply(`✅ Added alias: \`${alias}\` → **${canonical}**`);
      } catch (err) {
        await interaction.editReply(`❌ Failed to add alias: ${(err as Error).message}`);
      }
      return;
    }

    // ── remove ───────────────────────────────────────────────────────────────
    if (sub === 'remove') {
      await interaction.deferReply({ ephemeral: true });

      const idOrAlias = interaction.options.getString('id_or_alias', true).trim();
      const numericId = parseInt(idOrAlias, 10);

      try {
        if (!isNaN(numericId)) {
          // Remove by ID
          await (prisma as any).termAlias.delete({ where: { id: numericId } });
          await normalizer.invalidate();
          await interaction.editReply(`✅ Removed alias with ID \`${numericId}\`.`);
        } else {
          // Remove by alias string (may match multiple canonicals)
          const deleted = await (prisma as any).termAlias.deleteMany({
            where: { alias: idOrAlias.toLowerCase() },
          });
          await normalizer.invalidate();
          if (deleted.count === 0) {
            await interaction.editReply(`ℹ️ No alias found matching \`${idOrAlias}\`.`);
          } else {
            await interaction.editReply(`✅ Removed ${deleted.count} alias(es) matching \`${idOrAlias}\`.`);
          }
        }
      } catch (err) {
        await interaction.editReply(`❌ Failed to remove alias: ${(err as Error).message}`);
      }
      return;
    }

    // ── list ─────────────────────────────────────────────────────────────────
    if (sub === 'list') {
      await interaction.deferReply({ ephemeral: true });

      const page = (interaction.options.getInteger('page') ?? 1) - 1;
      const total = await (prisma as any).termAlias.count();
      const rows = await (prisma as any).termAlias.findMany({
        orderBy: [{ canonical: 'asc' }, { alias: 'asc' }],
        skip: page * PAGE_SIZE,
        take: PAGE_SIZE,
      });

      if (rows.length === 0) {
        await interaction.editReply('ℹ️ No term aliases found.');
        return;
      }

      const totalPages = Math.ceil(total / PAGE_SIZE);
      const lines = rows.map((r: any) => `\`${r.id}\` \`${r.alias}\` → **${r.canonical}**`);

      const embed = new EmbedBuilder()
        .setTitle('📖 BDO Term Aliases')
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Page ${page + 1}/${totalPages} — ${total} total aliases` })
        .setColor(0x5865f2);

      await interaction.editReply({ embeds: [embed] });
    }
  },
};
