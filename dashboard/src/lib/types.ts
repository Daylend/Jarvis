// Client-side mirror of src/voice/mind-types.ts. Kept in sync by hand (the bot
// and dashboard are separate packages).

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

export type MindEventType =
  | 'mind:context'
  | 'mind:slice'
  | 'mind:slice:update'
  | 'mind:timeline'
  | 'transcript:final'
  | 'ack:state'
  | 'llm:dispatch'
  | 'llm:iter'
  | 'llm:ttft'
  | 'llm:think'
  | 'llm:tool_request'
  | 'llm:tool_result'
  | 'llm:token'
  | 'llm:final'
  | 'llm:trim'
  | 'state:tick'
  | 'hello';

export interface MindEvent {
  type: MindEventType;
  payload: any;
  t: number;
}
