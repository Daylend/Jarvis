import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction } from 'discord.js';
import axios from 'axios';
import { prisma } from '../db';
import { config } from '../config';
import { Command } from '../types';
import { setContext } from '../ai-context';
import { unlockChannel, lockChannel, getChannelUnlock } from '../channel-lock';

export const aiCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('ai')
    .setDescription('Chat with AI')
    .addSubcommand(subcommand =>
      subcommand
        .setName('chat')
        .setDescription('Chat with AI')
        .addStringOption(option =>
          option.setName('provider')
            .setDescription('The AI provider to use')
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption(option =>
          option.setName('prompt')
            .setDescription('The prompt to send')
            .setRequired(true)
        )
        .addAttachmentOption(option =>
          option.setName('image')
            .setDescription('Optional image to attach')
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('unlock')
        .setDescription('Unlock AI for this channel')
        .addStringOption(option =>
          option.setName('provider')
            .setDescription('The AI provider to use')
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addIntegerOption(option =>
          option.setName('minutes')
            .setDescription('Duration in minutes')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('lock')
        .setDescription('Lock AI for this channel')
    ),
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focusedValue = interaction.options.getFocused();
    const providers = await prisma.aIProvider.findMany({
      where: {
        name: {
          contains: focusedValue,
        },
      },
      take: 25,
    });
    await interaction.respond(
      providers.map(p => ({ name: p.name, value: p.name }))
    );
  },
  execute: async (interaction: ChatInputCommandInteraction) => {
    const subcommand = interaction.options.getSubcommand();

    // Owner check for management commands
    if (subcommand === 'unlock' || subcommand === 'lock') {
      if (interaction.user.id !== config.ownerId) {
        await interaction.reply({ content: 'You are not authorized to use this command.', ephemeral: true });
        return;
      }
    }

    // For chat, check owner OR unlocked channel
    if (subcommand === 'chat') {
      const unlock = getChannelUnlock(interaction.channelId);
      if (interaction.user.id !== config.ownerId && !unlock) {
        await interaction.reply({ content: 'You are not authorized to use this command.', ephemeral: true });
        return;
      }
    }

    if (subcommand === 'unlock') {
      const providerName = interaction.options.getString('provider', true);
      const minutes = interaction.options.getInteger('minutes', true);

      const provider = await prisma.aIProvider.findUnique({
        where: { name: providerName },
      });

      if (!provider) {
        await interaction.reply({ content: `Provider '${providerName}' not found.`, ephemeral: true });
        return;
      }

      unlockChannel(interaction.channelId, providerName, minutes);
      await interaction.reply({ content: `AI unlocked in this channel for ${minutes} minutes using provider '${providerName}'.` });
      return;
    }

    if (subcommand === 'lock') {
      lockChannel(interaction.channelId);
      await interaction.reply({ content: 'AI locked in this channel.' });
      return;
    }

    if (subcommand === 'chat') {
      await interaction.deferReply();

      const providerName = interaction.options.getString('provider', true);
      const prompt = interaction.options.getString('prompt', true);
      const image = interaction.options.getAttachment('image');

      const provider = await prisma.aIProvider.findUnique({
        where: { name: providerName },
      });

      if (!provider) {
        await interaction.editReply(`Provider '${providerName}' not found.`);
        return;
      }

      const messages: any[] = [];
      const userContent: any[] = [{ type: 'text', text: prompt }];

      if (image) {
        userContent.push({
          type: 'image_url',
          image_url: {
            url: image.url,
          },
        });
      }

      messages.push({ role: 'user', content: userContent });

      try {
        const response = await axios.post(
          `${config.openWebUiUrl}/chat/completions`,
          {
            model: provider.model,
            messages: messages,
          },
          {
            headers: {
              'Authorization': `Bearer ${config.openWebUiKey}`,
              'Content-Type': 'application/json',
            },
          }
        );

        const replyContent = response.data.choices[0].message.content;
        
        const chunks = replyContent.match(/[\s\S]{1,2000}/g) || [];
        
        let lastMessage;
        for (const chunk of chunks) {
          if (!lastMessage) {
             lastMessage = await interaction.editReply(chunk);
          } else {
             lastMessage = await interaction.followUp(chunk);
          }
        }

        if (lastMessage) {
          // Save context
          messages.push({ role: 'assistant', content: replyContent });
          setContext(lastMessage.id, {
            providerModel: provider.model,
            history: messages,
          });
        }

      } catch (error: any) {
        console.error('AI Error:', error.response?.data || error.message);
        await interaction.editReply('Error communicating with AI provider.');
      }
    }
  },
};
