import { Client, GatewayIntentBits, Events, Collection, Partials } from 'discord.js';
import { config } from './config';
import { commands } from './commands';
import { prisma } from './db';
import { angryResponses } from './angry-responses';
import { bootstrapVoice, sessionManager, handleDmJarvis, handleMentionJarvis } from './voice';
import { personalityStore } from './voice/personality-store';
import { llmProviderStore } from './voice/llm-provider-store';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const commandMap = new Collection<string, any>();
for (const command of commands) {
  commandMap.set(command.data.name, command);
}

// Build-time stamp — update this string when deploying to confirm new image is running
const BUILD_STAMP = '2026-05-12T06:53:00Z [debug-pcm-logging]';

client.once(Events.ClientReady, async (c) => {
  console.log(`Ready! Logged in as ${c.user.tag} | build: ${BUILD_STAMP}`);
  await bootstrapVoice(client);
  personalityStore.init().catch((err) => {
    console.error('[startup] personalityStore.init failed:', err);
  });
  llmProviderStore.init();
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

  // DM from owner → Jarvis pipeline
  if (!message.guild && message.author.id === config.ownerId) {
    try {
      await handleDmJarvis(client, message);
    } catch (err) {
      console.error('[dm-jarvis] Error handling owner DM:', err);
      await (message.channel as any).send('Something went wrong processing your message.').catch(() => {});
    }
    return;
  }

  // @Mention Logic
  if (client.user && message.mentions.has(client.user)) {
    // Owner @-mention → Jarvis LLM (shares conversation history with DM + voice).
    if (message.author.id === config.ownerId && config.jarvisMentionEnabled) {
      try {
        await handleMentionJarvis(client, message);
      } catch (err) {
        console.error('[mention-jarvis] Error handling owner @mention:', err);
        await message.reply('Something went wrong processing your message.').catch(() => {});
      }
      return;
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
