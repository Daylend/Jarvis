/**
 * Small authenticated-via-reverse-proxy HTTP API for the dashboard Settings page.
 * Bound to config.dashboardHttpPort on the internal network. Read + mutate the
 * same stores the Discord /jarvis command uses.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Client } from 'discord.js';
import { config } from '../config';
import { personalityStore } from '../voice/personality-store';
import { llmProviderStore } from '../voice/llm-provider-store';
import { sessionManager } from '../voice/session-manager';
import { clearAllHistory } from '../voice/jarvis-handler';
import { mindBus } from '../voice/mind-bus';
import { mindState } from '../voice/mind-state';
import axios from 'axios';

let server: ReturnType<typeof createServer> | null = null;
let discordClient: Client | null = null;

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(json);
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function checkSidecar(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await axios.get(`${url}/healthz`, { timeout: 2000 });
    const d = res.data as any;
    return { ok: d.status === 'ok', detail: `engine: ${d.engine ?? '?'}, model: ${d.model ?? '?'}` };
  } catch {
    return { ok: false, detail: 'unreachable' };
  }
}

async function handleGetState(): Promise<unknown> {
  const p = personalityStore.getActive();
  const ack = personalityStore.getAckConfig();
  const llm = llmProviderStore.getStatus();
  const models = await llmProviderStore.listModels();
  const sounds = personalityStore.listSounds();
  const personalities = personalityStore.list();

  // Find owner's current voice channel across guilds + active session.
  let voiceSession: any = null;
  let ownerVoice: { guildId: string; guildName: string; channelId: string; channelName: string } | null = null;
  if (discordClient) {
    for (const [gId] of discordClient.guilds.cache) {
      const session = sessionManager.get(gId);
      if (session) {
        voiceSession = {
          guildId: session.guildId,
          channelId: session.channelId,
          startedAt: session.startedAt,
        };
      }
      const guild = discordClient.guilds.cache.get(gId);
      try {
        const member = await guild?.members.fetch(config.ownerId);
        const vc = member?.voice.channel;
        if (vc) {
          ownerVoice = { guildId: gId, guildName: guild?.name ?? '', channelId: vc.id, channelName: vc.name };
          break;
        }
      } catch { /* ignore */ }
    }
  }

  const asrHealth = await checkSidecar(config.transcribeHttpUrl);
  let ttsHealth = { ok: false, detail: 'unknown' };
  try {
    const { ttsClient } = await import('../voice/tts-client');
    ttsHealth = await ttsClient.checkHealth();
  } catch { /* ignore */ }

  return {
    personality: {
      active: p ? { id: p.id, name: p.name, persona: p.persona, voice: p.voice, speed: p.speed, description: p.description } : null,
      list: personalities,
    },
    llm: { ...llm, models: models ?? [] },
    ack: {
      ackEnabled: ack.ackEnabled,
      ackSound: ack.ackSound,
      soundPath: ack.soundPath,
      source: ack.source,
      sounds,
      activePersonalityId: personalityStore.getActiveId(),
    },
    voice: {
      session: voiceSession,
      ownerVoice,
      asr: asrHealth,
      tts: ttsHealth,
      autoJoinOwner: config.autoJoinOwner,
      triggerPhrase: config.triggerPhrase,
    },
    mentionEnabled: config.jarvisMentionEnabled,
  };
}

async function handleRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${config.dashboardHttpPort}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  try {
    if (path === '/api/state' && method === 'GET') {
      return send(res, 200, await handleGetState());
    }

    if (path === '/api/memory/reset' && method === 'POST') {
      await clearAllHistory();
      // emitClearedContext runs inside clearAllHistory; signal completion.
      return send(res, 200, { ok: true });
    }

    if (path === '/api/personality/set' && method === 'POST') {
      const { id } = await readJson(req);
      await personalityStore.setActive(id);
      const status = personalityStore.getApplyStatus();
      const p = personalityStore.getActive();
      mindBus.emit('ack:state', { guild: '', active: false }); // nudge settings refresh
      return send(res, 200, { ok: true, active: { id: p?.id, name: p?.name }, apply: status });
    }

    if (path === '/api/personality/reload' && method === 'POST') {
      const result = await personalityStore.reload();
      return send(res, 200, { ok: true, ...result });
    }

    if (path === '/api/llm/set' && method === 'POST') {
      const { backend, model } = await readJson(req);
      llmProviderStore.setBackend(backend, model);
      return send(res, 200, { ok: true, status: llmProviderStore.getStatus() });
    }

    if (path === '/api/llm/thinking' && method === 'POST') {
      const { enabled } = await readJson(req);
      llmProviderStore.setThinking(!!enabled);
      return send(res, 200, { ok: true, thinking: llmProviderStore.isThinkingEnabled() });
    }

    if (path === '/api/ack/set' && method === 'POST') {
      const { ackSound } = await readJson(req);
      const id = personalityStore.getActiveId();
      if (!id) return send(res, 400, { error: 'No active personality' });
      const soundPath = personalityStore.resolveSoundPath(ackSound);
      if (!soundPath) return send(res, 400, { error: `Sound not found: ${ackSound}` });
      personalityStore.setAckOverride(id, { ackSound });
      return send(res, 200, { ok: true, ackSound });
    }

    if (path === '/api/ack/enable' && method === 'POST') {
      const { enabled } = await readJson(req);
      const id = personalityStore.getActiveId();
      if (!id) return send(res, 400, { error: 'No active personality' });
      personalityStore.setAckOverride(id, { ackEnabled: !!enabled });
      return send(res, 200, { ok: true, ackEnabled: !!enabled });
    }

    if (path === '/api/voice/start' && method === 'POST') {
      if (!discordClient) return send(res, 500, { error: 'Discord client not ready' });
      const { guildId, channelId } = await readJson(req);
      const guild = discordClient.guilds.cache.get(guildId);
      if (!guild) return send(res, 400, { error: 'Guild not found' });
      const member = await guild.members.fetch(config.ownerId);
      const voiceChannel = member?.voice?.channel;
      if (!voiceChannel || voiceChannel.id !== channelId) {
        return send(res, 400, { error: 'Owner is not in that voice channel' });
      }
      const ctx = await sessionManager.start({ guild, voiceChannel, startedBy: config.ownerId, client: discordClient });
      return send(res, 200, { ok: true, session: { id: ctx.id, guildId: ctx.guildId, channelId: ctx.channelId } });
    }

    if (path === '/api/voice/stop' && method === 'POST') {
      const { guildId } = await readJson(req);
      await sessionManager.stop(guildId, 'dashboard');
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    return send(res, 500, { error: (err as Error).message });
  }
}

export function startHttpServer(client: Client): void {
  if (server) return;
  discordClient = client;
  server = createServer((req, res) => {
    handleRoute(req, res).catch((err) => send(res, 500, { error: (err as Error).message }));
  });
  server.listen(config.dashboardHttpPort, '0.0.0.0', () => {
    console.log(`[dashboard-http] listening on http://0.0.0.0:${config.dashboardHttpPort}`);
  });
}

export function stopHttpServer(): void {
  if (server) { server.close(); server = null; }
}
