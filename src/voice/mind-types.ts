/**
 * Mind-bus event contract — the exact shapes the dashboard consumes.
 * Ported from `dashboard/mockups/shared/fake-mind.js` (the mockup IS the contract).
 * Event names are prefixed `mind:`/`llm:`/`transcript:`/`ack:`/`state:` to match
 * the mockup's switch in `glass.js`.
 */

export interface SystemPromptParts {
  header: string;
  rules: string[];
  persona: string;
  examples: string;
  footer: string;
  notes: Array<{ id: number; title: string }>;
  skills: Array<{ name: string; desc: string; active: boolean }>;
}

export interface ContextInfo {
  used: number;
  budget: number;
}

export interface MindStats {
  tokPerSec: number;
  ttft: number;
  iter: number;
  lastElapsed: number;
  totalTurns: number;
  historyCount?: number;
  voiceLines?: number;
}

export interface VoiceLine {
  mmss: string;
  name: string;
  owner: boolean;
  text: string;
  avatarUrl?: string;
}

export interface TransientFields {
  time: string;
  members: string[];
  voiceCtx: VoiceLine[];
  command: string;
}

export interface HistoryMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text: string;
  name?: string;
  transient?: boolean;
}

export interface SliceSummary {
  id: number;
  t: number;
  time: string;
  command: string;
  status: 'pending' | 'done';
  reply: string | null;
  tokPerSec: number;
  elapsedMs: number;
  hadTool: boolean;
}

export interface SliceSnapshot {
  systemPrompt: SystemPromptParts;
  history: HistoryMessage[];
  transient: TransientFields;
  context: ContextInfo;
}

export interface MindContextPayload extends SliceSnapshot {
  stats: MindStats;
}

export interface MindSession {
  active: boolean;
  guild: string;
  channel?: string;
}

export type TurnSource = 'voice' | 'dm' | 'mention' | 'trigger';

/** Discriminated union of every mind-bus event payload. */
export interface MindEventMap {
  'mind:context': MindContextPayload;
  'mind:slice': { slice: SliceSummary; slices: SliceSummary[] };
  'mind:slice:update': { slice: SliceSummary };
  'mind:timeline': {
    selected: number | null;
    snapshot?: SliceSnapshot;
    summary?: SliceSummary;
    slices: SliceSummary[];
  };
  'transcript:final': {
    speaker: string;
    owner: boolean;
    text: string;
    startMs: number;
    avatarUrl?: string;
  };
  'ack:state': { guild: string; active: boolean };
  'llm:dispatch': {
    key: string;
    prompt: string;
    source: TurnSource;
    backend: string;
    model: string;
  };
  'llm:iter': { key: string; iter: number; max: number };
  'llm:ttft': { key: string; ms: number };
  'llm:think': { key: string; text: string };
  'llm:tool_request': {
    key: string;
    name: string;
    args: Record<string, unknown>;
    requiresApproval: boolean;
  };
  'llm:tool_result': { key: string; name: string; result: string; ok: boolean };
  'llm:token': { key: string; text: string };
  'llm:final': {
    key: string;
    text: string;
    tokensIn: number;
    tokensOut: number;
    tokPerSec: number;
    elapsedMs: number;
  };
  'llm:trim': { used: number; budget: number };
  'state:tick': {
    stats: MindStats;
    context: ContextInfo;
    session: MindSession;
  };
  /** Sent by the WS server on client connect — not emitted by the loop. */
  hello: {
    session: MindSession;
    slices: SliceSummary[];
    context: MindContextPayload | null;
  };
  /** Sent by a client to scrub a past slice — not emitted by the loop. */
  'mind:select': { id: number | null };
}

export type MindEventType = keyof MindEventMap;
export type MindEventPayload<T extends MindEventType> = MindEventMap[T];

export interface MindEvent<T extends MindEventType = MindEventType> {
  type: T;
  payload: MindEventPayload<T>;
  t: number;
}
