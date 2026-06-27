/** Types for the OpenAI-compatible streaming chat completion. */

export interface ChatStreamDelta {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
  /** llama.cpp thinking field (when enable_thinking). */
  thinking?: string;
  /** OpenRouter reasoning field. */
  reasoning?: string;
}

export interface StreamedAssistantMsg {
  role: 'assistant';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  /** Accumulated thinking/reasoning text (separate from content). */
  thinking?: string;
}
