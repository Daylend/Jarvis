import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { config } from '../config';
import { clearAllHistory } from '../voice/jarvis-handler';
import type { Command } from '../types';

export const jarvisCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('jarvis')
    .setDescription('Manage Jarvis assistant')
    .addSubcommand((sub) =>
      sub
        .setName('forget')
        .setDescription('Wipe all Jarvis conversation memory (does not affect stored transcripts)'),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.user.id !== config.ownerId) {
      await interaction.reply({ content: 'This command is owner-only.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'forget') {
      clearAllHistory();
      await interaction.reply({ content: 'Jarvis memory wiped. Starting fresh.', ephemeral: true });
    }
  },
};
