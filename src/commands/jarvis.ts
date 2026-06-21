import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, EmbedBuilder } from 'discord.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { clearAllHistory } from '../voice/jarvis-handler';
import { personalityStore } from '../voice/personality-store';
import { llmProviderStore } from '../voice/llm-provider-store';
import { sessionManager } from '../voice/session-manager';
import { ttsClient } from '../voice/tts-client';
import type { Command } from '../types';

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
          s.setName('models').setDescription('List available local models on the llama.cpp router'),
        )
        .addSubcommand((s) =>
          s.setName('thinking')
            .setDescription('Toggle thinking mode (enable_thinking in chat_template_kwargs)')
            .addBooleanOption((o) =>
              o.setName('enabled').setDescription('Enable or disable thinking').setRequired(true),
            ),
        )
        .addSubcommand((s) =>
          s.setName('set')
            .setDescription('Switch the LLM backend')
            .addStringOption((o) =>
              o.setName('backend').setDescription('Backend').setRequired(true)
                .addChoices({ name: 'local', value: 'local' }, { name: 'openrouter', value: 'openrouter' }),
            )
            .addStringOption((o) =>
              o.setName('model').setDescription('Model name or ID (supports local autocomplete)').setAutocomplete(true),
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
    )
    .addSubcommandGroup((g) =>
      g.setName('listen').setDescription('Control voice transcription session')
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
    )
    .addSubcommandGroup((g) =>
      g.setName('ack').setDescription('Manage voice acknowledgement (sound + green indicator)')
        .addSubcommand((s) =>
          s.setName('show').setDescription('Show the active personality ack config'),
        )
        .addSubcommand((s) =>
          s.setName('list').setDescription('List available ack sounds in the sounds folder'),
        )
        .addSubcommand((s) =>
          s.setName('set')
            .setDescription('Set the ack sound for the active personality (pick from folder)')
            .addStringOption((o) =>
              o.setName('name').setDescription('Sound filename').setRequired(true).setAutocomplete(true),
            ),
        )
        .addSubcommand((s) =>
          s.setName('upload')
            .setDescription('Upload a new ack sound and set it for the active personality')
            .addAttachmentOption((o) =>
              o.setName('file').setDescription('Audio file (.wav .mp3 .flac .ogg .m4a .opus)').setRequired(true),
            ),
        )
        .addSubcommand((s) =>
          s.setName('enable')
            .setDescription('Enable or disable ack for the active personality')
            .addBooleanOption((o) =>
              o.setName('enabled').setDescription('Enable or disable').setRequired(true),
            ),
        )
        .addSubcommand((s) =>
          s.setName('test').setDescription('Play the current ack sound once in your voice channel'),
        ),
    ),

  autocomplete: async (interaction: AutocompleteInteraction) => {
    if (interaction.user.id !== config.ownerId) {
      await interaction.respond([]);
      return;
    }

    const group = interaction.options.getSubcommandGroup(false);
    if (group === 'personality') {
      const focused = interaction.options.getFocused();
      const all = personalityStore.list();
      const filtered = all.filter((p) =>
        `${p.name} ${p.id}`.toLowerCase().includes(focused.toLowerCase()),
      );
      await interaction.respond(
        filtered.slice(0, 25).map((p) => ({ name: `${p.name} (${p.id})`, value: p.id })),
      );
      return;
    }

    if (group === 'llm') {
      const focused = interaction.options.getFocused();
      const backend = interaction.options.getString('backend');
      if (backend === 'openrouter') {
        await interaction.respond([]);
        return;
      }
      const models = await llmProviderStore.listModels();
      if (!models) {
        await interaction.respond([]);
        return;
      }
      const filtered = models.filter((m) =>
        m.id.toLowerCase().includes(focused.toLowerCase()),
      );
      await interaction.respond(
        filtered.slice(0, 25).map((m) => ({ name: `${m.id} (${m.status})`, value: m.id })),
      );
      return;
    }

    if (group === 'ack') {
      const focused = interaction.options.getFocused();
      const sounds = personalityStore.listSounds();
      const filtered = sounds.filter((s) => s.toLowerCase().includes(focused.toLowerCase()));
      await interaction.respond(
        filtered.slice(0, 25).map((s) => ({ name: s, value: s })),
      );
      return;
    }

    await interaction.respond([]);
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
          content: `Backend: **${st.backend}**\nModel: ${st.model}\nThinking: **${st.thinking ? 'enabled' : 'disabled'}**\nReady: ${st.ready ? 'yes' : 'no (missing OPENROUTER_API_KEY)'}`,
          ephemeral: true,
        });
        return;
      }
      if (sub === 'thinking') {
        const enabled = interaction.options.getBoolean('enabled', true);
        llmProviderStore.setThinking(enabled);
        await interaction.reply({
          content: `Thinking mode is now **${enabled ? 'enabled' : 'disabled'}** for local llama.cpp requests.`,
          ephemeral: true,
        });
        return;
      }
      if (sub === 'models') {
        await interaction.deferReply({ ephemeral: true });
        const models = await llmProviderStore.listModels();
        if (!models) {
          await interaction.editReply({
            content: '❌ Llama.cpp router model list is unavailable. Ensure the llama.cpp server is running, reachable, and configured in router mode (without `-m` and with `--models-dir`).',
          });
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle('Llama.cpp Router Models')
          .setColor(0x5865f2);

        if (models.length === 0) {
          embed.setDescription('No models found on the router.');
        } else {
          const currentLocalModel = llmProviderStore.getModel();
          const activeBackend = llmProviderStore.getBackend();

          const lines = models.map((m) => {
            const isActive = activeBackend === 'local' && m.id === currentLocalModel;
            return isActive
              ? `▶ **${m.id}** — status: \`${m.status}\``
              : `  ${m.id} — status: \`${m.status}\``;
          });
          embed.setDescription(lines.join('\n'));
        }

        await interaction.editReply({ embeds: [embed] });
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

    if (group === 'listen') {
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
            client: interaction.client,
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
        const ttsHealth = await ttsClient.checkHealth();

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
              name: 'TTS Sidecar',
              value: ttsHealth.ok ? `✅ Online — ${ttsHealth.detail}` : `❌ Offline — ${ttsHealth.detail}`,
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
    }

    if (group === 'ack') {
      if (sub === 'show') {
        await interaction.deferReply({ ephemeral: true });
        const ack = personalityStore.getAckConfig();
        const p = personalityStore.getActive();
        await interaction.editReply(
          `Personality: **${p?.name ?? '?'}** (${personalityStore.getActiveId()})\n` +
          `Ack enabled: **${ack.ackEnabled ? 'yes' : 'no'}**\n` +
          `Ack sound: \`${ack.ackSound}\` ${ack.soundPath ? '✓' : '⚠ (file not found)'}\n` +
          `Source: ${ack.source}`,
        );
        return;
      }

      if (sub === 'list') {
        await interaction.deferReply({ ephemeral: true });
        const sounds = personalityStore.listSounds();
        const ack = personalityStore.getAckConfig();
        const embed = new EmbedBuilder()
          .setTitle('Ack Sounds')
          .setColor(0x5865f2);
        if (sounds.length === 0) {
          embed.setDescription(`No audio files found in \`${config.soundsDir}\`.`);
        } else {
          const lines = sounds.map((s) =>
            s === ack.ackSound ? `▶ **${s}** (active)` : `  ${s}`,
          );
          embed.setDescription(lines.join('\n'));
        }
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (sub === 'set') {
        await interaction.deferReply({ ephemeral: true });
        const name = interaction.options.getString('name', true);
        const id = personalityStore.getActiveId();
        if (!id) {
          await interaction.editReply('No active personality.');
          return;
        }
        const soundPath = personalityStore.resolveSoundPath(name);
        if (!soundPath) {
          await interaction.editReply(`❌ Sound not found in \`${config.soundsDir}\`: ${name}`);
          return;
        }
        personalityStore.setAckOverride(id, { ackSound: name });
        await interaction.editReply(`Ack sound → **${name}** (for active personality).`);
        return;
      }

      if (sub === 'upload') {
        await interaction.deferReply({ ephemeral: true });
        const attachment = interaction.options.getAttachment('file', true);
        const allowed = ['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.opus'];
        const ext = path.extname(attachment.name).toLowerCase();
        if (!allowed.includes(ext)) {
          await interaction.editReply(`❌ Unsupported file type \`${ext}\`. Allowed: ${allowed.join(', ')}`);
          return;
        }
        // Sanitize filename: basename + alnum/-/_/. only
        const safeName = path.basename(attachment.name).replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!safeName) {
          await interaction.editReply('❌ Invalid filename.');
          return;
        }
        try {
          if (!fs.existsSync(config.soundsDir)) {
            fs.mkdirSync(config.soundsDir, { recursive: true });
          }
          const dest = path.join(config.soundsDir, safeName);
          // Path traversal guard: resolved dest must be inside soundsDir.
          const resolvedDir = path.resolve(config.soundsDir);
          const resolvedDest = path.resolve(dest);
          if (resolvedDest !== resolvedDir && !resolvedDest.startsWith(resolvedDir + path.sep)) {
            await interaction.editReply('❌ Invalid destination path.');
            return;
          }
          const res = await axios.get(attachment.url, { responseType: 'arraybuffer', timeout: 30_000 });
          fs.writeFileSync(dest, Buffer.from(res.data));
          const id = personalityStore.getActiveId();
          if (id) personalityStore.setAckOverride(id, { ackSound: safeName });
          await interaction.editReply(`Uploaded and set ack sound → **${safeName}** (${res.data.length} bytes).`);
        } catch (err) {
          await interaction.editReply(`❌ Upload failed: ${(err as Error).message}`);
        }
        return;
      }

      if (sub === 'enable') {
        await interaction.deferReply({ ephemeral: true });
        const enabled = interaction.options.getBoolean('enabled', true);
        const id = personalityStore.getActiveId();
        if (!id) {
          await interaction.editReply('No active personality.');
          return;
        }
        personalityStore.setAckOverride(id, { ackEnabled: enabled });
        await interaction.editReply(`Ack **${enabled ? 'enabled' : 'disabled'}** for active personality.`);
        return;
      }

      if (sub === 'test') {
        await interaction.deferReply({ ephemeral: true });
        const ctx = sessionManager.get(interaction.guildId!);
        if (!ctx) {
          await interaction.editReply('❌ No active voice session in this server. Start listening first.');
          return;
        }
        const ack = personalityStore.getAckConfig();
        if (!ack.soundPath) {
          await interaction.editReply(`❌ Ack sound file not found: \`${ack.ackSound}\``);
          return;
        }
        try {
          await ttsClient.playSoundFile(ctx.connection, ack.soundPath, ctx.guildId);
          await interaction.editReply(`▶ Played ack sound **${ack.ackSound}** once.`);
        } catch (err) {
          await interaction.editReply(`❌ Failed to play: ${(err as Error).message}`);
        }
        return;
      }
    }
  },
};