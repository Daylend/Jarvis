import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { prisma } from '../db';
import { config } from '../config';
import { Command } from '../types';

export const quotesCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('quotes')
    .setDescription('Manage quotes')
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('Add a new quote')
        .addStringOption(option =>
          option.setName('text').setDescription('The quote text').setRequired(true)
        )
        .addStringOption(option =>
          option.setName('type')
            .setDescription('The type of quote')
            .setRequired(true)
            .addChoices(
              { name: 'Funny', value: 'funny' },
              { name: 'Angry', value: 'angry' }
            )
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove')
        .setDescription('Remove a quote by ID')
        .addIntegerOption(option =>
          option.setName('id').setDescription('The quote ID').setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List quotes')
        .addStringOption(option =>
          option.setName('type')
            .setDescription('Filter by type')
            .addChoices(
              { name: 'Funny', value: 'funny' },
              { name: 'Angry', value: 'angry' }
            )
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('import')
        .setDescription('Import multiple quotes from JSON')
        .addStringOption(option =>
          option.setName('type')
            .setDescription('The type of quotes')
            .setRequired(true)
            .addChoices(
              { name: 'Funny', value: 'funny' },
              { name: 'Angry', value: 'angry' }
            )
        )
        .addStringOption(option =>
          option.setName('json')
            .setDescription('JSON array of strings: ["quote1", "quote2"]')
            .setRequired(true)
        )
    ),
  execute: async (interaction: ChatInputCommandInteraction) => {
    if (interaction.user.id !== config.ownerId) {
      await interaction.reply({ content: 'You are not authorized to use this command.', ephemeral: true });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'add') {
      const text = interaction.options.getString('text', true);
      const type = interaction.options.getString('type', true);
      
      const quote = await prisma.quote.create({
        data: {
          text,
          type,
          addedBy: interaction.user.id,
        },
      });
      await interaction.reply({ content: `${type.charAt(0).toUpperCase() + type.slice(1)} quote added with ID: ${quote.id}`, ephemeral: true });
    } else if (subcommand === 'import') {
      const type = interaction.options.getString('type', true);
      const json = interaction.options.getString('json', true);
      
      try {
        const quotes = JSON.parse(json);
        if (!Array.isArray(quotes) || !quotes.every((q: any) => typeof q === 'string')) {
          await interaction.reply({ content: 'Invalid JSON. Must be an array of strings.', ephemeral: true });
          return;
        }

        const count = await prisma.quote.createMany({
          data: quotes.map((text: string) => ({
            text,
            type,
            addedBy: interaction.user.id,
          })),
        });

        await interaction.reply({ content: `Successfully imported ${count.count} ${type} quotes.`, ephemeral: true });
      } catch (error) {
        console.error(error);
        await interaction.reply({ content: 'Error parsing JSON or importing quotes.', ephemeral: true });
      }
    } else if (subcommand === 'remove') {
      const id = interaction.options.getInteger('id', true);
      try {
        await prisma.quote.delete({
          where: { id },
        });
        await interaction.reply({ content: `Quote ${id} removed.`, ephemeral: true });
      } catch (error) {
        await interaction.reply({ content: `Quote ${id} not found.`, ephemeral: true });
      }
    } else if (subcommand === 'list') {
      const type = interaction.options.getString('type');
      const where = type ? { type } : {};

      const quotes = await prisma.quote.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 20,
      });

      if (quotes.length === 0) {
        await interaction.reply({ content: 'No quotes found.', ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(`Quotes ${type ? `(${type})` : ''} (Last 20)`)
        .setDescription(quotes.map(q => `**#${q.id}** [${q.type}]: ${q.text}`).join('\n'));

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
};
