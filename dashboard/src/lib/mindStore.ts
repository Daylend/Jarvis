// Svelte store holding the live mind-dashboard state. Ports the switch in
// `dashboard/mockups/shared/glass.js` into store mutations.
import { writable } from 'svelte/store';
import type {
  MindContextPayload,
  MindSession,
  SliceSummary,
  SliceSnapshot,
  SystemPromptParts,
  TransientFields,
  VoiceLine,
} from './types';

export interface GenState {
  think: string;
  tools: Array<{
    name: string;
    args: any;
    requiresApproval: boolean;
    result: string | null;
    ok: boolean | null;
  }>;
  reply: string;
}

export interface MindStore {
  connected: boolean;
  viewMode: 'live' | 'slice';
  selectedSliceId: number | null;
  sliceSummaries: SliceSummary[];
  session: MindSession;
  // telemetry (state:tick)
  stats: { tokPerSec: number; ttft: number; iter: number; lastElapsed: number; totalTurns: number };
  context: { used: number; budget: number };
  // context window
  systemPrompt: SystemPromptParts | null;
  history: MindContextPayload['history'];
  transient: TransientFields | null;
  voiceBuf: VoiceLine[];
  // live generating tail
  gen: GenState;
  // timeline detail
  detailSlice: SliceSummary | null;
}

const emptyStats = { tokPerSec: 0, ttft: 0, iter: 0, lastElapsed: 0, totalTurns: 0 };

function initial(): MindStore {
  return {
    connected: false,
    viewMode: 'live',
    selectedSliceId: null,
    sliceSummaries: [],
    session: { active: false, guild: '', channel: '' },
    stats: { ...emptyStats },
    context: { used: 0, budget: 0 },
    systemPrompt: null,
    history: [],
    transient: null,
    voiceBuf: [],
    gen: { think: '', tools: [], reply: '' },
    detailSlice: null,
  };
}

export const mind = writable<MindStore>(initial());

function resetGen(s: MindStore): void {
  s.gen = { think: '', tools: [], reply: '' };
}

function setTransient(s: MindStore, t: TransientFields | null): void {
  s.transient = t;
  if (t) {
    s.voiceBuf = (t.voiceCtx || []).map((v) => ({ ...v }));
  }
}

export function applyEvent(evt: { type: string; payload: any }): void {
  mind.update((s) => {
    const { type, payload } = evt;
    switch (type) {
      case 'hello': {
        s.connected = true;
        if (payload.session) s.session = payload.session;
        if (payload.slices) s.sliceSummaries = payload.slices;
        if (payload.context) {
          const c: MindContextPayload = payload.context;
          s.systemPrompt = c.systemPrompt;
          s.history = c.history;
          setTransient(s, c.transient);
          s.stats = { ...s.stats, ...c.stats };
          s.context = c.context;
        }
        break;
      }
      case 'mind:context': {
        if (s.viewMode === 'slice') break;
        s.systemPrompt = payload.systemPrompt;
        s.history = payload.history;
        setTransient(s, payload.transient);
        if (payload.stats) s.stats = { ...s.stats, ...payload.stats };
        if (payload.context) s.context = payload.context;
        break;
      }
      case 'mind:slice': {
        s.sliceSummaries = payload.slices;
        break;
      }
      case 'mind:slice:update': {
        const sl = payload.slice;
        const idx = s.sliceSummaries.findIndex((x) => x.id === sl.id);
        if (idx >= 0) s.sliceSummaries[idx] = sl; else s.sliceSummaries.push(sl);
        if (s.viewMode === 'slice' && s.selectedSliceId === sl.id) s.detailSlice = sl;
        break;
      }
      case 'mind:timeline': {
        if (payload.selected === null) {
          s.viewMode = 'live';
          s.selectedSliceId = null;
          s.detailSlice = null;
        } else {
          s.selectedSliceId = payload.selected;
          s.viewMode = 'slice';
          const snap: SliceSnapshot = payload.snapshot;
          if (snap) {
            s.systemPrompt = snap.systemPrompt;
            s.history = snap.history;
            setTransient(s, snap.transient);
            s.context = snap.context;
          }
          s.detailSlice = payload.summary;
        }
        break;
      }
      case 'transcript:final': {
        if (s.viewMode === 'slice') break;
        const now = new Date();
        const mmss = `${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        s.voiceBuf.push({ mmss, name: payload.speaker, owner: payload.owner, text: payload.text, avatarUrl: payload.avatarUrl });
        while (s.voiceBuf.length > 24) s.voiceBuf.shift();
        break;
      }
      case 'ack:state': {
        s.session = { ...s.session, active: payload.active };
        break;
      }
      case 'llm:dispatch': {
        resetGen(s);
        s.session = { ...s.session, active: true };
        break;
      }
      case 'llm:iter': {
        s.stats.iter = payload.iter;
        break;
      }
      case 'llm:ttft': {
        s.stats.ttft = payload.ms;
        break;
      }
      case 'llm:think': {
        s.gen.think += payload.text;
        break;
      }
      case 'llm:tool_request': {
        s.gen.tools.push({ name: payload.name, args: payload.args, requiresApproval: payload.requiresApproval, result: null, ok: null });
        break;
      }
      case 'llm:tool_result': {
        const t = s.gen.tools.find((x) => x.name === payload.name && x.result === null);
        if (t) { t.result = payload.result; t.ok = payload.ok; }
        break;
      }
      case 'llm:token': {
        s.gen.reply += payload.text;
        break;
      }
      case 'llm:final': {
        s.stats.lastElapsed = payload.elapsedMs;
        s.session = { ...s.session, active: false };
        break;
      }
      case 'llm:trim': {
        s.context = { ...s.context, used: payload.used, budget: payload.budget };
        break;
      }
      case 'state:tick': {
        s.stats = { ...s.stats, ...payload.stats };
        s.context = payload.context;
        if (payload.session) s.session = payload.session;
        break;
      }
    }
    return s;
  });
}

export function resetStore(): void {
  mind.set(initial());
}
