import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, EmbedBuilder } from 'discord.js';
import { config } from '../config';
import { personalityStore } from '../voice/personality-store';
import type { Command } from '../types';

export const personalityCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('personality')
    .setDescription('Manage Jarvis personalities (prompt + voice + speed)')
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('List available personalities'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Switch the active personality')
        .addStringOption((option) =>
          option
            .setName('id')
            .setDescription('Personality ID')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('show')
        .setDescription('Show details for the active personality'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reload')
        .setDescription('Reload all personality files from disk'),
    ),

  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused();
    const all = personalityStore.list();
    const filtered = all.filter((p) =>
      `${p.name} ${p.id}`.toLowerCase().includes(focused.toLowerCase()),
    );
    await interaction.respond(
      filtered.slice(0, 25).map((p) => ({ name: `${p.name} (${p.id})`, value: p.id })),
    );
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.user.id !== config.ownerId) {
      await interaction.reply({ content: 'This command is owner-only.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      await interaction.deferReply({ ephemeral: true });

      const all = personalityStore.list();

      const embed = new EmbedBuilder()
        .setTitle('Personalities')
        .setColor(0x5865f2);

      if (all.length === 0) {
        embed.setDescription('No personalities loaded.');
      } else {
        const lines = all.map((p) =>
          p.active
            ? `▶ **${p.name}** (${p.id}) — voice: ${p.voice}, speed: ${p.speed}x`
            : `  ${p.name} (${p.id}) — voice: ${p.voice}, speed: ${p.speed}x`,
        );
        embed.setDescription(lines.join('\n'));
      }

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === 'set') {
      await interaction.deferReply({ ephemeral: true });

      const id = interaction.options.getString('id', true);

      try {
        await personalityStore.setActive(id);
        const p = personalityStore.getActive()!;
        const status = personalityStore.getApplyStatus();
        const voiceNote = status.voiceOk ? '' : '\n⚠ Voice apply failed (TTS may be unavailable)';
        const speedNote = status.speedOk ? '' : '\n⚠ Speed apply failed (TTS may be unavailable)';
        await interaction.editReply(
          `Personality → **${p.name}**\nVoice: ${p.voice} · Speed: ${p.speed}x${voiceNote}${speedNote}`,
        );
      } catch (err) {
        await interaction.editReply(`Failed to set personality: ${(err as Error).message}`);
      }
      return;
    }

    if (sub === 'show') {
      await interaction.deferReply({ ephemeral: true });

      const p = personalityStore.getActive();
      if (!p) {
        await interaction.editReply('No active personality.');
        return;
      }

      const status = personalityStore.getApplyStatus();
      const embed = new EmbedBuilder()
        .setTitle(`Active: ${p.name}`)
        .setColor(0x5865f2)
        .addFields(
          { name: 'ID', value: p.id, inline: true },
          { name: 'Voice', value: `${p.voice} ${status.voiceOk ? '✓' : '⚠'}`, inline: true },
          { name: 'Speed', value: `${p.speed}x ${status.speedOk ? '✓' : '⚠'}`, inline: true },
          { name: 'Description', value: p.description || '(none)' },
        );

      const personaPreview = p.persona.length > 800
        ? p.persona.slice(0, 800) + '...'
        : p.persona;
      embed.addFields({ name: 'Persona', value: personaPreview });

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === 'reload') {
      await interaction.deferReply({ ephemeral: true });

      try {
        const result = await personalityStore.reload();
        const p = personalityStore.getActive();
        const status = personalityStore.getApplyStatus();

        let msg = `Reloaded: ${result.loaded} loaded, ${result.skipped} skipped.`;
        if (p) {
          msg += `\nActive: **${p.name}** (${p.id})`;
          msg += `\nVoice: ${p.voice} ${status.voiceOk ? '✓' : '⚠'} · Speed: ${p.speed}x ${status.speedOk ? '✓' : '⚠'}`;
        }

        await interaction.editReply(msg);
      } catch (err) {
        await interaction.editReply(`Failed to reload: ${(err as Error).message}`);
      }
    }
  },
};