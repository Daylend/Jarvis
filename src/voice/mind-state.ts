/**
 * Retained mind-dashboard state — mirrors the `FakeMind` class in
 * `dashboard/mockups/shared/fake-mind.js`. Holds the rolling slice ring buffer,
 * last context snapshot (for WS reconnect rehydrate), per-owner stats (owner is
 * single in this bot), and the rolling voice window used to build the transient
 * [VOICE CHANNEL] block.
 *
 * Methods both update retained state AND emit via `mindBus` so the WS server only
 * has to subscribe + forward. The jarvis loop calls these (fire-and-forget).
 */
import { mindBus } from './mind-bus';
import type {
  ContextInfo,
  HistoryMessage,
  MindContextPayload,
  MindSession,
  MindStats,
  SliceSnapshot,
  SliceSummary,
  SystemPromptParts,
  TransientFields,
  VoiceLine,
} from './mind-types';

const MAX_SLICES = 50;
const MAX_VOICE = 40;

// Zeroed system prompt so rehydrate can return a non-null context even on a
// fresh boot with no captured slices yet — keeps the dashboard from showing a
// blank context pane until the first turn lands.
const EMPTY_SYSTEM_PROMPT: SystemPromptParts = {
  header: '',
  rules: [],
  persona: '',
  examples: '',
  footer: '',
  notes: [],
  skills: [],
};

// Zeroed transient so rehydrate can return a non-null context on a fresh boot.
const EMPTY_TRANSIENT: TransientFields = {
  time: '',
  members: [],
  voiceCtx: [],
  textCtx: [],
  command: '',
};

function summarizeSlice(s: {
  id: number; t: number; time: string; command: string;
  status: 'pending' | 'done'; reply: string | null; stats: MindStats;
  hadTool: boolean;
}): SliceSummary {
  return {
    id: s.id,
    t: s.t,
    time: s.time,
    command: s.command,
    status: s.status,
    reply: s.reply,
    tokPerSec: s.stats.tokPerSec,
    elapsedMs: s.stats.lastElapsed,
    hadTool: s.hadTool,
  };
}

interface FullSlice extends SliceSnapshot {
  id: number;
  t: number;
  time: string;
  command: string;
  status: 'pending' | 'done';
  reply: string | null;
  trace: string;
  tool: { name: string; args: Record<string, unknown>; requiresApproval: boolean; result: string | null } | null;
  stats: MindStats;
  hadTool: boolean;
}

class MindState {
  readonly stats: MindStats = {
    tokPerSec: 0,
    ttft: 0,
    iter: 0,
    lastElapsed: 0,
    totalTurns: 0,
    historyCount: 0,
    voiceLines: 0,
  };
  context: ContextInfo = { used: 0, budget: 0 };
  session: MindSession = { active: false, guild: '', channel: '' };

  private slices: FullSlice[] = [];
  private activeSliceId: number | null = null;
  private sliceCounter = 0;
  private voiceBuf: VoiceLine[] = [];

  /** Rolling voice window (last ~40 lines) used to build the transient block. */
  pushVoice(line: VoiceLine): VoiceLine[] {
    this.voiceBuf.push(line);
    while (this.voiceBuf.length > MAX_VOICE) this.voiceBuf.shift();
    this.stats.voiceLines = this.voiceBuf.length;
    return this.voiceBuf.slice(-12);
  }

  voiceWindow(): VoiceLine[] {
    return this.voiceBuf.slice();
  }

  /** Begin a new turn: bump counters, return the new slice id. */
  beginTurn(): number {
    this.stats.totalTurns += 1;
    this.sliceCounter += 1;
    return this.sliceCounter;
  }

  setSession(active: boolean, guild: string, channel = ''): void {
    this.session = { active, guild, channel };
  }

  updateStats(patch: Partial<MindStats>): void {
    Object.assign(this.stats, patch);
  }

  updateContext(patch: Partial<ContextInfo>): void {
    Object.assign(this.context, patch);
  }

  /**
   * Emit a full context snapshot + optionally capture an inference slice.
   * Mirrors `FakeMind._emitContext`.
   */
  emitContext(
    systemPrompt: SystemPromptParts,
    history: HistoryMessage[],
    transient: TransientFields,
    context: ContextInfo,
    opts: { captureSlice?: boolean; command?: string; trace?: string } = {},
  ): void {
    this.context = { ...context };
    this.stats.historyCount = history.length;

    const snapshot: SliceSnapshot = {
      systemPrompt: JSON.parse(JSON.stringify(systemPrompt)),
      history: history.map((h) => ({ ...h })),
      transient: { ...transient, voiceCtx: (transient.voiceCtx || []).map((v) => ({ ...v })) },
      context: { ...context },
    };

    if (opts.captureSlice && opts.command) {
      const now = new Date();
      const slice: FullSlice = {
        id: this.sliceCounter,
        t: now.getTime(),
        time: transient.time,
        command: opts.command,
        ...JSON.parse(JSON.stringify(snapshot)),
        trace: opts.trace ?? '',
        tool: null,
        reply: null,
        stats: { ...this.stats },
        status: 'pending',
        hadTool: false,
      };
      this.slices.push(slice);
      if (this.slices.length > MAX_SLICES) this.slices.shift();
      this.activeSliceId = slice.id;
      mindBus.emit('mind:slice', {
        slice: summarizeSlice(slice),
        slices: this.slices.map((s) => summarizeSlice(s)),
      });
    }

    const payload: MindContextPayload = {
      ...snapshot,
      stats: { ...this.stats },
    };
    mindBus.emit('mind:context', payload);
  }

  /** Patch the in-flight (last) slice's outcome fields. Mirrors `_patchSlice`. */
  patchSlice(patch: Partial<Pick<FullSlice, 'reply' | 'trace' | 'tool' | 'status' | 'stats' | 'hadTool'>>): void {
    const s = this.slices[this.slices.length - 1];
    if (!s) return;
    Object.assign(s, patch);
    mindBus.emit('mind:slice:update', { slice: summarizeSlice(s) });
  }

  /** Client-initiated scrub: select a past slice (null = live). */
  selectSlice(id: number | null): void {
    if (id === null) {
      this.activeSliceId = null;
      mindBus.emit('mind:timeline', { selected: null, slices: this.slices.map((s) => summarizeSlice(s)) });
      return;
    }
    const s = this.slices.find((x) => x.id === id);
    if (!s) return;
    this.activeSliceId = id;
    mindBus.emit('mind:timeline', {
      selected: id,
      snapshot: {
        systemPrompt: s.systemPrompt,
        history: s.history,
        transient: s.transient,
        context: s.context,
      },
      summary: summarizeSlice(s),
      slices: this.slices.map((x) => summarizeSlice(x)),
    });
  }

  /** Rehydrate payload for a freshly-connected WS client. */
  rehydrate(): {
    session: MindSession;
    slices: SliceSummary[];
    context: MindContextPayload;
    voiceBuf: VoiceLine[];
  } {
    const last = this.slices[this.slices.length - 1];
    const context: MindContextPayload = last
      ? {
          // Big structured fields from the last captured slice...
          systemPrompt: last.systemPrompt,
          history: last.history,
          transient: last.transient,
          // ...but always overlay LIVE stats/context so the dashboard reflects
          // current telemetry rather than the frozen slice snapshot.
          context: { ...this.context },
          stats: { ...this.stats },
        }
      : {
          // Fresh boot / no turns yet: empty structured fields but live stats/
          // context/session so the gauges + session pill paint immediately.
          systemPrompt: EMPTY_SYSTEM_PROMPT,
          history: [],
          transient: EMPTY_TRANSIENT,
          context: { ...this.context },
          stats: { ...this.stats },
        };
    return {
      session: { ...this.session },
      slices: this.slices.map((s) => summarizeSlice(s)),
      context,
      voiceBuf: this.voiceBuf.slice(-12),
    };
  }

  /** Full slice snapshot lookup (for timeline scrub). */
  getSlice(id: number): FullSlice | undefined {
    return this.slices.find((s) => s.id === id);
  }

  sliceSummaries(): SliceSummary[] {
    return this.slices.map((s) => summarizeSlice(s));
  }
}

export const mindState = new MindState();
