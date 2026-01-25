import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { prisma } from '../db';

const VOICES_DIR = path.join(process.cwd(), 'data', 'voices');

export const voiceCommand = {
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Manage voice models')
    .addSubcommandGroup(group =>
      group
        .setName('model')
        .setDescription('Manage voice models')
        .addSubcommand(subcommand =>
          subcommand
            .setName('list')
            .setDescription('List available voice models')
        )
        .addSubcommand(subcommand =>
          subcommand
            .setName('set')
            .setDescription('Set your preferred voice model')
            .addStringOption(option =>
              option.setName('name')
                .setDescription('The name of the voice model')
                .setRequired(true)
                .setAutocomplete(true)
            )
        )
        .addSubcommand(subcommand =>
          subcommand
            .setName('add')
            .setDescription('Add a new voice model')
            .addAttachmentOption(option =>
              option.setName('file')
                .setDescription('The audio file for the voice model')
                .setRequired(true)
            )
            .addStringOption(option =>
              option.setName('name')
                .setDescription('The name for the voice model (optional, defaults to filename)')
                .setRequired(false)
            )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Remove a voice model')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('The name of the voice model')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
    ),

  async autocomplete(interaction: any) {
    const focusedValue = interaction.options.getFocused();
    if (!fs.existsSync(VOICES_DIR)) {
        await interaction.respond([]);
        return;
    }
    const files = fs.readdirSync(VOICES_DIR).filter(f => f.endsWith('.wav') || f.endsWith('.mp3') || f.endsWith('.ogg') || f.endsWith('.flac'));
    const filtered = files.filter(choice => choice.startsWith(focusedValue));
    await interaction.respond(
      filtered.slice(0, 25).map(choice => ({ name: choice, value: choice }))
    );
  },

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    // Owner check for add, remove, set
    if (['add', 'remove', 'set'].includes(subcommand)) {
        if (interaction.user.id !== process.env.OWNER_USER_ID) {
            await interaction.reply({ content: 'You are not authorized to use this command.', ephemeral: true });
            return;
        }
    }

    if (subcommand === 'list') {
        if (!fs.existsSync(VOICES_DIR)) {
            await interaction.reply('No voices directory found.');
            return;
        }
        const files = fs.readdirSync(VOICES_DIR).filter(f => f.endsWith('.wav') || f.endsWith('.mp3') || f.endsWith('.ogg') || f.endsWith('.flac'));
        if (files.length === 0) {
            await interaction.reply('No voice models available.');
        } else {
            await interaction.reply(`Available voice models:\n${files.join('\n')}`);
        }
    } else if (subcommand === 'set') {
        const name = interaction.options.getString('name', true);

        if (name !== path.basename(name)) {
             await interaction.reply({ content: 'Invalid filename.', ephemeral: true });
             return;
        }

        // Verify it exists
        if (!fs.existsSync(path.join(VOICES_DIR, name))) {
             await interaction.reply({ content: `Voice model "${name}" not found.`, ephemeral: true });
             return;
        }

        await prisma.userPreference.upsert({
            where: { userId: interaction.user.id },
            update: { voice: name },
            create: { userId: interaction.user.id, voice: name },
        });
        await interaction.reply(`Your voice preference has been set to: ${name}`);

    } else if (subcommand === 'add') {
        const attachment = interaction.options.getAttachment('file', true);
        const nameOption = interaction.options.getString('name');
        
        let filename = nameOption ? nameOption : attachment.name;
        filename = path.basename(filename);

        if (!filename.endsWith(path.extname(attachment.name))) {
            filename += path.extname(attachment.name);
        }
        
        // Basic validation
        const allowedExts = ['.wav', '.mp3', '.ogg', '.flac'];
        if (!allowedExts.includes(path.extname(filename).toLowerCase())) {
             await interaction.reply({ content: 'Invalid file type. Allowed: wav, mp3, ogg, flac', ephemeral: true });
             return;
        }

        if (!fs.existsSync(VOICES_DIR)) {
            fs.mkdirSync(VOICES_DIR, { recursive: true });
        }

        const filePath = path.join(VOICES_DIR, filename);
        const file = fs.createWriteStream(filePath);
        
        https.get(attachment.url, function(response) {
            response.pipe(file);
            file.on('finish', async () => {
                file.close();
                await interaction.reply(`Voice model "${filename}" added successfully.`);
            });
        }).on('error', async (err) => {
            fs.unlink(filePath, () => {}); 
            await interaction.reply({ content: `Error downloading file: ${err.message}`, ephemeral: true });
        });

    } else if (subcommand === 'remove') {
        const name = interaction.options.getString('name', true);

        if (name !== path.basename(name)) {
             await interaction.reply({ content: 'Invalid filename.', ephemeral: true });
             return;
        }

        const filePath = path.join(VOICES_DIR, name);
        
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            await interaction.reply(`Voice model "${name}" removed.`);
        } else {
            await interaction.reply({ content: `Voice model "${name}" not found.`, ephemeral: true });
        }
    }
  },
};
