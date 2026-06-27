// Thin fetch client for the dashboard HTTP API. All calls return JSON.
// The dashboard gateway reverse-proxies /api/* to the bot, so calls are
// same-origin (relative).

function url(path: string): string {
  return path;
}

async function call<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(url(path), {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

export interface SettingsState {
  personality: {
    active: { id: string; name: string; persona: string; voice: string; speed: number; description: string } | null;
    list: Array<{ id: string; name: string; description: string; voice: string; speed: number; active: boolean }>;
  };
  llm: { backend: string; model: string; ready: boolean; thinking: boolean; models: Array<{ id: string; status: string }> };
  ack: {
    ackEnabled: boolean;
    ackSound: string;
    soundPath: string | null;
    source: string;
    sounds: string[];
    activePersonalityId: string | null;
  };
  voice: {
    session: { guildId: string; channelId: string; startedAt: string } | null;
    ownerVoice: { guildId: string; guildName: string; channelId: string; channelName: string } | null;
    asr: { ok: boolean; detail: string };
    tts: { ok: boolean; detail: string };
    autoJoinOwner: boolean;
    triggerPhrase: string;
  };
  mentionEnabled: boolean;
}

export const api = {
  state: () => call<SettingsState>('/api/state'),
  resetMemory: () => call<{ ok: boolean }>('/api/memory/reset', { method: 'POST' }),
  setPersonality: (id: string) => call('/api/personality/set', { method: 'POST', body: JSON.stringify({ id }) }),
  reloadPersonalities: () => call('/api/personality/reload', { method: 'POST' }),
  setLlm: (backend: string, model?: string) => call('/api/llm/set', { method: 'POST', body: JSON.stringify({ backend, model }) }),
  setThinking: (enabled: boolean) => call('/api/llm/thinking', { method: 'POST', body: JSON.stringify({ enabled }) }),
  setAckSound: (ackSound: string) => call('/api/ack/set', { method: 'POST', body: JSON.stringify({ ackSound }) }),
  setAckEnabled: (enabled: boolean) => call('/api/ack/enable', { method: 'POST', body: JSON.stringify({ enabled }) }),
  startVoice: (guildId: string, channelId: string) => call('/api/voice/start', { method: 'POST', body: JSON.stringify({ guildId, channelId }) }),
  stopVoice: (guildId: string) => call('/api/voice/stop', { method: 'POST', body: JSON.stringify({ guildId }) }),
};
