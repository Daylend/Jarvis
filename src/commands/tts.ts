import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { prisma } from '../db';

const TTS_API_URL = process.env.TTS_API_URL || 'http://localhost:5000/generate';

export const ttsCommand = {
  data: new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Generate speech from text')
    .addStringOption(option =>
      option.setName('text')
        .setDescription('The text to speak')
        .setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const member = interaction.member as GuildMember;
    if (!member.voice.channel) {
      await interaction.reply({ content: 'You need to be in a voice channel to use this command!', ephemeral: true });
      return;
    }

    const text = interaction.options.getString('text', true);

    // Get user preference
    const pref = await prisma.userPreference.findUnique({
        where: { userId: interaction.user.id },
    });

    if (!pref || !pref.voice) {
        await interaction.reply({ content: 'You have not selected a voice model. Use `/voice model set` to choose one.', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const response = await axios.post(TTS_API_URL, {
            text: text,
            voice: pref.voice
        }, {
            responseType: 'arraybuffer'
        });

        const buffer = Buffer.from(response.data);
        const tempFilePath = path.join(process.cwd(), `temp_tts_${interaction.id}.wav`);
        fs.writeFileSync(tempFilePath, buffer);

        const connection = joinVoiceChannel({
            channelId: member.voice.channel.id,
            guildId: interaction.guildId!,
            adapterCreator: interaction.guild!.voiceAdapterCreator,
        });

        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        } catch (error) {
            connection.destroy();
            await interaction.editReply('Failed to join voice channel within 30 seconds.');
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            return;
        }

        const player = createAudioPlayer();
        const resource = createAudioResource(tempFilePath);

        player.play(resource);
        connection.subscribe(player);

        player.on(AudioPlayerStatus.Idle, () => {
            connection.destroy();
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        });

        player.on('error', error => {
            console.error('Audio player error:', error);
            connection.destroy();
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        });

        await interaction.editReply(`Playing TTS: "${text}"`);

    } catch (error) {
        console.error('TTS Error:', error);
        if (axios.isAxiosError(error)) {
             if (error.code === 'ECONNREFUSED') {
                 await interaction.editReply('TTS Service is not running.');
             } else {
                 // Try to parse error message from buffer if possible, but usually it's JSON
                 // Since we requested arraybuffer, response.data is buffer.
                 try {
                     const errText = Buffer.from(error.response?.data).toString();
                     const errJson = JSON.parse(errText);
                     await interaction.editReply(`TTS Error: ${errJson.error || error.message}`);
                 } catch (e) {
                     await interaction.editReply(`TTS Error: ${error.message}`);
                 }
             }
        } else {
            await interaction.editReply('An error occurred while generating speech.');
        }
    }
  },
};
