import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, EmbedBuilder } from 'discord.js';
import { config } from '../config';
import { clearAllHistory } from '../voice/jarvis-handler';
import { personalityStore } from '../voice/personality-store';
import { llmProviderStore } from '../voice/llm-provider-store';
import type { Command } from '../types';

export const jarvisCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('jarvis')
    .setDescription('Manage Jarvis assistant')
    .addSubcommand((sub) =>
      sub
        .setName('forget')
        .setDescription('Wipe all Jarvis conversation memory (does not affect stored transcripts)'),
    )
    .addSubcommandGroup((g) =>
      g.setName('llm').setDescription('Manage Jarvis LLM backend')
        .addSubcommand((s) =>
          s.setName('show').setDescription('Show the active LLM backend and model'),
        )
        .addSubcommand((s) =>
          s.setName('set')
            .setDescription('Switch the LLM backend')
            .addStringOption((o) =>
              o.setName('backend').setDescription('Backend').setRequired(true)
                .addChoices({ name: 'local', value: 'local' }, { name: 'openrouter', value: 'openrouter' }),
            )
            .addStringOption((o) =>
              o.setName('model').setDescription('OpenRouter model id (openrouter only)'),
            ),
        ),
    )
    .addSubcommandGroup((g) =>
      g.setName('personality').setDescription('Manage Jarvis personalities')
        .addSubcommand((s) =>
          s.setName('list').setDescription('List available personalities'),
        )
        .addSubcommand((s) =>
          s.setName('set')
            .setDescription('Switch the active personality')
            .addStringOption((o) =>
              o.setName('id').setDescription('Personality ID').setRequired(true).setAutocomplete(true),
            ),
        )
        .addSubcommand((s) =>
          s.setName('show').setDescription('Show details for the active personality'),
        )
        .addSubcommand((s) =>
          s.setName('reload').setDescription('Reload all personality files from disk'),
        ),
    ),

  autocomplete: async (interaction: AutocompleteInteraction) => {
    if (interaction.options.getSubcommandGroup(false) !== 'personality') {
      await interaction.respond([]);
      return;
    }
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

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (!group && sub === 'forget') {
      clearAllHistory();
      await interaction.reply({ content: 'Jarvis memory wiped. Starting fresh.', ephemeral: true });
      return;
    }

    if (group === 'llm') {
      if (sub === 'show') {
        const st = llmProviderStore.getStatus();
        await interaction.reply({
          content: `Backend: **${st.backend}**\nModel: ${st.model}\nReady: ${st.ready ? 'yes' : 'no (missing OPENROUTER_API_KEY)'}`,
          ephemeral: true,
        });
        return;
      }
      if (sub === 'set') {
        const backend = interaction.options.getString('backend', true) as 'local' | 'openrouter';
        const model = interaction.options.getString('model') ?? undefined;
        try {
          llmProviderStore.setBackend(backend, model);
          const st = llmProviderStore.getStatus();
          await interaction.reply({
            content: `LLM → **${st.backend}** (model: ${st.model})`,
            ephemeral: true,
          });
        } catch (err) {
          await interaction.reply({ content: (err as Error).message, ephemeral: true });
        }
        return;
      }
    }

    if (group === 'personality') {
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
    }
  },
};