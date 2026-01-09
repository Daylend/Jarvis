import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { prisma } from '../db';
import { config } from '../config';
import { Command } from '../types';

export const providerCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('provider')
    .setDescription('Manage AI providers')
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('Add a new AI provider')
        .addStringOption(option =>
          option.setName('name').setDescription('The provider name (alias)').setRequired(true)
        )
        .addStringOption(option =>
          option.setName('model').setDescription('The model ID for OpenWebUI').setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove')
        .setDescription('Remove a provider by name')
        .addStringOption(option =>
          option.setName('name').setDescription('The provider name').setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List all providers')
    ),
  execute: async (interaction: ChatInputCommandInteraction) => {
    if (interaction.user.id !== config.ownerId) {
      await interaction.reply({ content: 'You are not authorized to use this command.', ephemeral: true });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'add') {
      const name = interaction.options.getString('name', true);
      const model = interaction.options.getString('model', true);

      try {
        await prisma.aIProvider.create({
          data: {
            name,
            model,
            addedBy: interaction.user.id,
          },
        });
        await interaction.reply({ content: `Provider '${name}' added (Model: ${model}).`, ephemeral: true });
      } catch (error) {
        await interaction.reply({ content: `Error adding provider. Name '${name}' might already exist.`, ephemeral: true });
      }
    } else if (subcommand === 'remove') {
      const name = interaction.options.getString('name', true);
      try {
        await prisma.aIProvider.delete({
          where: { name },
        });
        await interaction.reply({ content: `Provider '${name}' removed.`, ephemeral: true });
      } catch (error) {
        await interaction.reply({ content: `Provider '${name}' not found.`, ephemeral: true });
      }
    } else if (subcommand === 'list') {
      const providers = await prisma.aIProvider.findMany({
        orderBy: { name: 'asc' },
      });

      if (providers.length === 0) {
        await interaction.reply({ content: 'No providers found.', ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('AI Providers')
        .setDescription(providers.map(p => `**${p.name}**: ${p.model}`).join('\n'));

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
};
