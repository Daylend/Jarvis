import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, TextChannel, ChannelType } from 'discord.js';
import { Command } from '../types';

export const reactionsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('reactions')
    .setDescription('Manage reactions')
    .addSubcommand(subcommand =>
      subcommand
        .setName('missing')
        .setDescription('List members with a role who haven\'t reacted to specific messages')
        .addStringOption(option =>
          option.setName('roles')
            .setDescription('Space-separated list of role IDs or mentions')
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName('message_ids')
            .setDescription('Space-separated list of message IDs')
            .setRequired(true)
        )
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('The channel where the messages are (defaults to current)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
        .addBooleanOption(option =>
          option.setName('hide')
            .setDescription('Hide the response (ephemeral)')
            .setRequired(false)
        )
    ),
  execute: async (interaction: ChatInputCommandInteraction) => {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'missing') {
      const hide = interaction.options.getBoolean('hide') ?? false;
      await interaction.deferReply({ ephemeral: hide });

      const rolesString = interaction.options.getString('roles', true);
      const messageIdsString = interaction.options.getString('message_ids', true);
      const channelOption = interaction.options.getChannel('channel');
      
      const channel = (channelOption || interaction.channel) as TextChannel;

      if (!channel || !channel.isTextBased()) {
        await interaction.editReply('Invalid channel specified.');
        return;
      }

      const messageIds = messageIdsString.split(/[\s,]+/).filter(id => id.length > 0);
      // Extract role IDs from string (handles mentions <@&ID> and raw IDs)
      const roleIds = rolesString.match(/\d+/g) || [];
      
      if (roleIds.length === 0) {
          await interaction.editReply('No valid role IDs found.');
          return;
      }

      const reactedUserIds = new Set<string>();

      try {
        // Fetch all members of the guild to ensure role.members is populated
        if (interaction.guild) {
            await interaction.guild.members.fetch();
        }

        for (const msgId of messageIds) {
          try {
            const message = await channel.messages.fetch(msgId);
            const reactions = message.reactions.cache;
            
            for (const reaction of reactions.values()) {
              let lastId: string | undefined;
              while (true) {
                  const users = await reaction.users.fetch({ limit: 100, after: lastId });
                  if (users.size === 0) break;
                  
                  users.forEach(user => reactedUserIds.add(user.id));
                  lastId = users.last()?.id;
                  
                  if (users.size < 100) break;
              }
            }
          } catch (e) {
            console.error(`Failed to fetch message ${msgId}:`, e);
            await interaction.followUp({ content: `Warning: Could not fetch message ${msgId}. It might be deleted or I don't have access.`, ephemeral: hide });
          }
        }
        
        const targetMembers = new Map(); // Use Map to avoid duplicates by ID

        for (const roleId of roleIds) {
            try {
                const fetchedRole = await interaction.guild?.roles.fetch(roleId);
                if (fetchedRole) {
                    fetchedRole.members.forEach(member => {
                        targetMembers.set(member.id, member);
                    });
                }
            } catch (e) {
                console.error(`Failed to fetch role ${roleId}:`, e);
                // Continue
            }
        }
        
        if (targetMembers.size === 0) {
            await interaction.editReply('No members found in the specified roles.');
            return;
        }

        const missingMembers = Array.from(targetMembers.values()).filter((member: any) => !reactedUserIds.has(member.id));

        if (missingMembers.length === 0) {
          await interaction.editReply('Everyone with the specified roles has reacted!');
          return;
        }

        const memberList = missingMembers.map((m: any) => `${m.user.username} ${m.toString()}`).join('\n');
        
        if (memberList.length > 4000) {
             const chunks: string[] = [];
             let currentChunk = '';
             const lines = missingMembers.map((m: any) => `${m.user.username} ${m.toString()}`);
             
             for (const line of lines) {
                 if (currentChunk.length + line.length + 1 > 2000) { // Discord limit is 2000 per message usually, embed desc is 4096
                     chunks.push(currentChunk);
                     currentChunk = '';
                 }
                 currentChunk += line + '\n';
             }
             if (currentChunk) chunks.push(currentChunk);

             await interaction.editReply({ content: `Found ${missingMembers.length} members who haven't reacted. Sending list...` });
             
             for (const chunk of chunks) {
                 // Send as separate messages if too long for one embed
                 await interaction.followUp({ content: chunk, ephemeral: hide });
             }
        } else {
            const embed = new EmbedBuilder()
            .setTitle(`Missing Reactions (${missingMembers.length})`)
            .setDescription(memberList)
            .setColor('Red');

            await interaction.editReply({ embeds: [embed] });
        }

      } catch (error) {
        console.error(error);
        await interaction.editReply('An error occurred while checking reactions.');
      }
    }
  },
};
