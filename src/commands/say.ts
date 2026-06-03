import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { config } from '../config';
import { sessionManager } from '../voice/session-manager';
import { ttsClient } from '../voice/tts-client';
import type { Command } from '../types';

export const sayCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('Speak text aloud in the voice channel using F5-TTS')
    .addStringOption((option) =>
      option
        .setName('text')
        .setDescription('Text to speak in the voice channel')
        .setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.user.id !== config.ownerId) {
      await interaction.reply({ content: 'This command is owner-only.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const ctx = sessionManager.get(interaction.guildId!);
    if (!ctx) {
      await interaction.editReply('No active listening session in this server. Use `/jarvis listen start` first.');
      return;
    }

    const text = interaction.options.getString('text', true);

    try {
      await ttsClient.speak(ctx.connection, text, ctx.guildId);
      await interaction.editReply(`Spoke: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`);
    } catch (err) {
      await interaction.editReply(`TTS failed: ${(err as Error).message}`);
    }
  },
};
