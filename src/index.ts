import { Client, GatewayIntentBits, Events, Collection, Message } from 'discord.js';
import { config } from './config';
import { commands } from './commands';
import { prisma } from './db';
import { angryResponses } from './angry-responses';
import { getContext, setContext } from './ai-context';
import { getChannelUnlock } from './channel-lock';
import { resolveMentions } from './utils';
import { bootstrapVoice, sessionManager } from './voice';
import axios from 'axios';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const commandMap = new Collection<string, any>();
for (const command of commands) {
  commandMap.set(command.data.name, command);
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Ready! Logged in as ${c.user.tag}`);
  await bootstrapVoice(client);
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) {
    const command = commandMap.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'There was an error executing this command!', ephemeral: true });
      } else {
        await interaction.reply({ content: 'There was an error executing this command!', ephemeral: true });
      }
    }
  } else if (interaction.isAutocomplete()) {
    const command = commandMap.get(interaction.commandName);
    if (!command || !command.autocomplete) return;

    try {
      await command.autocomplete(interaction);
    } catch (error) {
      console.error(error);
    }
  }
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  // AI Reply Logic
  if (message.reference && message.reference.messageId) {
    const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
    if (referencedMessage.author.id === client.user?.id) {
      const context = getContext(referencedMessage.id);
      if (context) {
        // Check reply limit
        const replyCount = context.history.filter((m: any) => m.role === 'assistant').length;
        if (replyCount >= 10) {
           await message.reply("Conversation limit reached. Please start a new conversation.");
           return;
        }

        // Check if channel is unlocked or user is owner
        const unlock = getChannelUnlock(message.channelId);
        if (message.author.id !== config.ownerId && !unlock) {
          // If not owner and not unlocked, do nothing (and return to avoid falling through)
          return; 
        }

        // Continue conversation
        const displayName = message.member?.displayName || message.author.displayName;
        const resolvedContent = await resolveMentions(message.content, message.client, message.guild);
        const userPrompt = `${displayName} (${message.author.username}): ${resolvedContent}`;
        const userContent: any[] = [{ type: 'text', text: userPrompt }];
        // Handle attachments in reply if any (optional, but good to have)
        if (message.attachments.size > 0) {
             message.attachments.forEach(att => {
                 userContent.push({ type: 'image_url', image_url: { url: att.url } });
             });
        }

        context.history.push({ role: 'user', content: userContent as any });

        try {
          // Show typing
          await message.channel.sendTyping();

          const response = await axios.post(
            `${config.openWebUiUrl}/chat/completions`,
            {
              model: context.providerModel,
              messages: context.history,
            },
            {
              headers: {
                'Authorization': `Bearer ${config.openWebUiKey}`,
                'Content-Type': 'application/json',
              },
            }
          );

          const replyContent = response.data.choices[0].message.content.trim().replace(/\n{3,}/g, '\n\n');
          
          // Split and send
          const chunks = replyContent.match(/[\s\S]{1,2000}/g) || [];
          let lastMessage;
          for (const chunk of chunks) {
             lastMessage = await message.reply(chunk);
          }

          if (lastMessage) {
            context.history.push({ role: 'assistant', content: replyContent });
            setContext(lastMessage.id, context);
          }

        } catch (error) {
          console.error('AI Reply Error:', error);
          await message.reply('Error continuing conversation.');
        }
      }
      // Return here to prevent falling through to @mention logic if it was a reply to the bot
      return;
    }
  }

  // @Mention Logic
  if (client.user && message.mentions.has(client.user)) {
    // Check if channel is unlocked for AI
    const unlock = getChannelUnlock(message.channelId);
    if (unlock) {
      // AI Response instead of Angry/Quote
      try {
        await message.channel.sendTyping();

        // Get provider model
        const provider = await prisma.aIProvider.findUnique({
          where: { name: unlock.providerName },
        });

        if (!provider) {
           // Fallback if provider deleted?
           return; 
        }

        const displayName = message.member?.displayName || message.author.displayName;
        const resolvedContent = await resolveMentions(message.content, message.client, message.guild);
        const userPrompt = `${displayName} (${message.author.username}): ${resolvedContent}`;
        const messages: any[] = [{ role: 'user', content: userPrompt }];

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

          const replyContent = response.data.choices[0].message.content.trim().replace(/\n{3,}/g, '\n\n');
          
          const chunks = replyContent.match(/[\s\S]{1,2000}/g) || [];
          let lastMessage;
          for (const chunk of chunks) {
             lastMessage = await message.reply(chunk);
          }

          if (lastMessage) {
            messages.push({ role: 'assistant', content: replyContent });
            setContext(lastMessage.id, {
              providerModel: provider.model,
              history: messages,
            });
          }
          return; // Don't do angry logic

      } catch (error) {
        console.error("AI Unlock Error", error);
      }
    }

    const rng = Math.random() * 100;
    
    if (rng < 70) {
      // Angry response
      const count = await prisma.quote.count({ where: { type: 'angry' } });
      if (count > 0) {
        const skip = Math.floor(Math.random() * count);
        const quote = await prisma.quote.findFirst({
          where: { type: 'angry' },
          skip: skip,
        });
        if (quote) {
          await message.reply(quote.text);
        } else {
           await message.reply(angryResponses[Math.floor(Math.random() * angryResponses.length)]);
        }
      } else {
        // Fallback to hardcoded if no DB quotes
        await message.reply(angryResponses[Math.floor(Math.random() * angryResponses.length)]);
      }
    } else {
      // Quote response (Funny)
      const count = await prisma.quote.count({ where: { type: 'funny' } });
      if (count > 0) {
        const skip = Math.floor(Math.random() * count);
        const quote = await prisma.quote.findFirst({
          where: { type: 'funny' },
          skip: skip,
        });
        if (quote) {
          await message.reply(quote.text);
        } else {
            await message.reply("I have nothing funny to say.");
        }
      } else {
        await message.reply("I have nothing funny to say.");
      }
    }
  }
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] Received ${signal}, shutting down gracefully...`);
  try {
    await sessionManager.shutdownAll();
    console.log('[shutdown] All voice sessions closed.');
  } catch (err) {
    console.error('[shutdown] Error during voice teardown:', err);
  }
  await prisma.$disconnect();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(config.discordToken);
