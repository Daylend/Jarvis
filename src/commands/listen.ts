import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import axios from 'axios';
import { config } from '../config';
import { sessionManager } from '../voice/session-manager';
import type { Command } from '../types';

function ownerOnly(interaction: ChatInputCommandInteraction): boolean {
  if (interaction.user.id !== config.ownerId) {
    interaction.reply({ content: '🔒 This command is owner-only.', ephemeral: true });
    return false;
  }
  return true;
}

async function checkSidecarHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await axios.get(`${config.transcribeHttpUrl}/healthz`, { timeout: 2000 });
    const data = res.data as any;
    const detail = `engine: ${data.engine ?? '?'}, model: ${data.model ?? '?'}, vulkan: ${data.vulkan ?? '?'}`;
    return { ok: data.status === 'ok', detail };
  } catch {
    return { ok: false, detail: 'unreachable' };
  }
}

export const listenCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('listen')
    .setDescription('Control voice transcription session')
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Start listening in your current voice channel'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('stop')
        .setDescription('Stop the active listening session in this server'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Show current session status and sidecar health'),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!ownerOnly(interaction)) return;

    const sub = interaction.options.getSubcommand();

    if (sub === 'start') {
      await interaction.deferReply({ ephemeral: true });

      const member = await interaction.guild?.members.fetch(interaction.user.id);
      const voiceChannel = member?.voice.channel;

      if (!voiceChannel) {
        await interaction.editReply('❌ You must be in a voice channel to start listening.');
        return;
      }

      try {
        const ctx = await sessionManager.start({
          guild: interaction.guild!,
          voiceChannel,
          startedBy: interaction.user.id,
        });
        await interaction.editReply(
          `✅ Listening started in **${voiceChannel.name}** (session \`${ctx.id}\`).`,
        );
      } catch (err) {
        await interaction.editReply(`❌ Failed to start session: ${(err as Error).message}`);
      }
      return;
    }

    if (sub === 'stop') {
      await interaction.deferReply({ ephemeral: true });

      const ctx = sessionManager.get(interaction.guildId!);
      if (!ctx) {
        await interaction.editReply('ℹ️ No active listening session in this server.');
        return;
      }

      await sessionManager.stop(interaction.guildId!, 'manual');
      await interaction.editReply('🛑 Listening session stopped.');
      return;
    }

    if (sub === 'status') {
      await interaction.deferReply({ ephemeral: true });

      const ctx = sessionManager.get(interaction.guildId!);
      const health = await checkSidecarHealth();

      const embed = new EmbedBuilder()
        .setTitle('🎙️ Transcription Status')
        .setColor(ctx ? 0x57f287 : 0xed4245)
        .addFields(
          {
            name: 'Session',
            value: ctx
              ? `✅ Active — <#${ctx.channelId}>\nID: \`${ctx.id}\`\nStarted: <t:${Math.floor(ctx.startedAt.getTime() / 1000)}:R>`
              : '❌ No active session',
            inline: false,
          },
          {
            name: 'ASR Sidecar',
            value: health.ok ? `✅ Online — ${health.detail}` : `❌ Offline — ${health.detail}`,
            inline: false,
          },
          {
            name: 'Auto-join owner',
            value: config.autoJoinOwner ? '✅ Enabled' : '❌ Disabled',
            inline: true,
          },
          {
            name: 'Trigger phrase',
            value: `\`${config.triggerPhrase}\``,
            inline: true,
          },
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    }
  },
};
