import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  DISCORD_TOKEN: z.string(),
  CLIENT_ID: z.string(),
  OWNER_USER_ID: z.string(),
  DATABASE_URL: z.string(),
  OPENWEBUI_API_URL: z.string().url(),
  OPENWEBUI_API_KEY: z.string(),
});

const env = envSchema.parse(process.env);

export const config = {
  discordToken: env.DISCORD_TOKEN,
  clientId: env.CLIENT_ID,
  ownerId: env.OWNER_USER_ID,
  openWebUiUrl: env.OPENWEBUI_API_URL,
  openWebUiKey: env.OPENWEBUI_API_KEY,
};
