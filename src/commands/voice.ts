import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, EmbedBuilder } from 'discord.js';
import axios from 'axios';
import { config } from '../config';
import type { Command } from '../types';

export const voiceCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Manage TTS voice samples')
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('List available voice samples'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Switch the active TTS voice')
        .addStringOption((option) =>
          option
            .setName('name')
            .setDescription('Voice sample filename')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    ),

  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused();
    try {
      const res = await axios.get(`${config.ttsUrl}/voices`, { timeout: 3000 });
      const voices: string[] = res.data?.voices ?? [];
      const filtered = voices.filter((v) =>
        v.toLowerCase().includes(focused.toLowerCase()),
      );
      await interaction.respond(
        filtered.slice(0, 25).map((v) => ({ name: v, value: v })),
      );
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.user.id !== config.ownerId) {
      await interaction.reply({ content: 'This command is owner-only.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      await interaction.deferReply({ ephemeral: true });

      try {
        const res = await axios.get(`${config.ttsUrl}/voices`, { timeout: 5000 });
        const data = res.data as { current: string | null; voices: string[] };

        const embed = new EmbedBuilder()
          .setTitle('Available Voice Samples')
          .setColor(0x5865f2);

        if (data.voices.length === 0) {
          embed.setDescription('No voice samples found.');
        } else {
          const lines = data.voices.map((v) =>
            v === data.current ? `▶ **${v}** (active)` : `  ${v}`,
          );
          embed.setDescription(lines.join('\n'));
        }

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        await interaction.editReply(`Failed to list voices: ${(err as Error).message}`);
      }
      return;
    }

    if (sub === 'set') {
      await interaction.deferReply({ ephemeral: true });

      const name = interaction.options.getString('name', true);

      try {
        const res = await axios.post(
          `${config.ttsUrl}/voice`,
          { name },
          { headers: { 'Content-Type': 'application/json' }, timeout: 120_000 },
        );
        await interaction.editReply(
          `Voice switched to **${res.data.voice}**.\nTranscript: "${res.data.transcript}"`,
        );
      } catch (err) {
        const msg = axios.isAxiosError(err) && err.response?.data?.detail
          ? err.response.data.detail
          : (err as Error).message;
        await interaction.editReply(`Failed to set voice: ${msg}`);
      }
    }
  },
};