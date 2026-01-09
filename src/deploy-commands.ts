import { REST, Routes } from 'discord.js';
import { config } from './config';
import { commands } from './commands';

const rest = new REST().setToken(config.discordToken);

(async () => {
  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    const commandsData = commands.map(command => command.data.toJSON());

    // Global deployment
    await rest.put(
      Routes.applicationCommands(config.clientId),
      { body: commandsData },
    );

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();
