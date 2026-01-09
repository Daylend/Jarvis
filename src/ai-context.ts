interface AIContext {
  providerModel: string;
  history: { role: string; content: string }[];
}

// Map<BotMessageId, Context>
const contextCache = new Map<string, AIContext>();

export const getContext = (messageId: string) => contextCache.get(messageId);

export const setContext = (messageId: string, context: AIContext) => {
  contextCache.set(messageId, context);
  // Simple cleanup: if size > 100, delete oldest
  if (contextCache.size > 100) {
    const firstKey = contextCache.keys().next().value;
    if (firstKey) contextCache.delete(firstKey);
  }
};
