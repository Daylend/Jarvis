import { Client, Guild } from 'discord.js';

export async function resolveMentions(text: string, client: Client, guild?: Guild | null): Promise<string> {
  const mentionRegex = /<@!?(\d+)>/g;
  const matches = [...text.matchAll(mentionRegex)];
  
  if (matches.length === 0) return text;

  // Deduplicate IDs to fetch
  const ids = [...new Set(matches.map(m => m[1]))];
  const replacements = new Map<string, string>();

  for (const id of ids) {
    try {
      let displayName = 'Unknown';
      let username = 'Unknown';
      if (guild) {
        try {
          const member = await guild.members.fetch(id);
          displayName = member.displayName;
          username = member.user.username;
        } catch {
           const user = await client.users.fetch(id);
           displayName = user.displayName || user.username;
           username = user.username;
        }
      } else {
        const user = await client.users.fetch(id);
        displayName = user.displayName || user.username;
        username = user.username;
      }
      replacements.set(id, `${displayName}/${username}`);
    } catch (e) {
      // Ignore fetch errors
    }
  }

  return text.replace(mentionRegex, (match, id) => {
    const info = replacements.get(id);
    if (info) {
      return `${match} (${info})`;
    }
    return match;
  });
}
