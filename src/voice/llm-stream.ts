/**
 * OpenAI-compatible SSE streaming client for both backends (llama.cpp, OpenRouter).
 * Performs a streaming POST, parses `data: {...}\n\n` chunks, and invokes a
 * callback per delta. Resolves with the fully-accumulated assistant message.
 */
import type { ChatStreamDelta, StreamedAssistantMsg } from './llm-stream-types';

export interface StreamCallbacks {
  /** First content OR reasoning delta seen — caller records TTFT. */
  onFirstDelta?: () => void;
  /** Reasoning/thinking text delta (llama.cpp `thinking`, OpenRouter `reasoning`). */
  onThink?: (text: string) => void;
  /** Reply content text delta. */
  onToken?: (text: string) => void;
}

/**
 * Stream a chat completion. Returns the accumulated assistant message (content +
 * tool_calls), mirroring the buffered `choice.message` shape the loop already
 * consumes, so the post-stream branching on tool_calls is unchanged.
 */
export async function streamChatCompletion(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
  cb: StreamCallbacks,
): Promise<StreamedAssistantMsg> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let firstDeltaSeen = false;
  const acc: StreamedAssistantMsg = {
    role: 'assistant',
    content: '',
    tool_calls: [],
  };
  // tool_calls arrive as partial fragments indexed by `index`; accumulate.
  const toolCallFrags: Map<number, { id: string; name: string; args: string }> = new Map();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM stream HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of rawEvent.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let json: any;
          try { json = JSON.parse(data); } catch { continue; }

          const delta: ChatStreamDelta | undefined = json.choices?.[0]?.delta;
          if (!delta) continue;

          if (!firstDeltaSeen) {
            firstDeltaSeen = true;
            cb.onFirstDelta?.();
          }

          // Reasoning/thinking text (llama.cpp: delta.thinking; OpenRouter: delta.reasoning).
          const thinkText = (delta as any).thinking ?? (delta as any).reasoning;
          if (typeof thinkText === 'string' && thinkText.length > 0) {
            acc.thinking = (acc.thinking ?? '') + thinkText;
            cb.onThink?.(thinkText);
          }

          // Content delta.
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            acc.content += delta.content;
            cb.onToken?.(delta.content);
          }

          // Tool-call fragment deltas (OpenAI streaming format).
          if (Array.isArray(delta.tool_calls)) {
            for (const frag of delta.tool_calls) {
              const idx = typeof frag.index === 'number' ? frag.index : 0;
              const ex = toolCallFrags.get(idx) ?? { id: '', name: '', args: '' };
              if (frag.id) ex.id = frag.id;
              if (frag.function?.name) ex.name += frag.function.name;
              if (frag.function?.arguments) ex.args += frag.function.arguments;
              toolCallFrags.set(idx, ex);
            }
          }
        }
      }
    }

    // Finalize accumulated tool_calls in index order.
    acc.tool_calls = [...toolCallFrags.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id,
        type: 'function' as const,
        function: { name: v.name, arguments: v.args },
      }));
    if (acc.tool_calls.length === 0) delete acc.tool_calls;

    return acc;
  } finally {
    clearTimeout(timer);
  }
}
