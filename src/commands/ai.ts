import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction } from 'discord.js';
import axios from 'axios';
import { prisma } from '../db';
import { config } from '../config';
import { Command } from '../types';
import { setContext } from '../ai-context';

export const aiCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('ai')
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
    if (interaction.user.id !== config.ownerId) {
      await interaction.reply({ content: 'You are not authorized to use this command.', ephemeral: true });
      return;
    }

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
      
      // Split message if too long (Discord limit 2000)
      // For simplicity, just taking first 2000 chars or sending as file if huge?
      // Let's just truncate/split for now.
      
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
  },
};
