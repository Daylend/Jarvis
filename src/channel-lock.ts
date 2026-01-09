interface ChannelUnlock {
  providerName: string;
  expiresAt: number;
}

// Map<ChannelId, ChannelUnlock>
const unlockedChannels = new Map<string, ChannelUnlock>();

export const unlockChannel = (channelId: string, providerName: string, durationMinutes: number) => {
  const expiresAt = Date.now() + durationMinutes * 60 * 1000;
  unlockedChannels.set(channelId, { providerName, expiresAt });
};

export const lockChannel = (channelId: string) => {
  unlockedChannels.delete(channelId);
};

export const getChannelUnlock = (channelId: string): ChannelUnlock | null => {
  const unlock = unlockedChannels.get(channelId);
  if (!unlock) return null;

  if (Date.now() > unlock.expiresAt) {
    unlockedChannels.delete(channelId);
    return null;
  }

  return unlock;
};
